import fs from 'node:fs';
import path from 'node:path';
import { LlmError } from './util.js';

const VAR_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const ID_PATTERN = /^[a-zA-Z0-9_.:-]+$/;

/**
 * Extract deduplicated `{{variable}}` names from one or more template strings.
 */
export function extractTemplateVariables(...texts) {
  const vars = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const match of text.matchAll(VAR_PATTERN)) {
      if (match[1]) vars.add(match[1]);
    }
  }
  return [...vars];
}

/**
 * Safely interpolate `{{variable}}` placeholders in `text` using `variables`.
 */
export function interpolateTemplate(text, variables = {}) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(VAR_PATTERN, (_full, name) => {
    const val = variables?.[name];
    return val === undefined || val === null ? '' : String(val);
  });
}

/**
 * Versioned Prompt Registry (`P2-1` / Matrix #14).
 *
 * Manages centralized prompt templates (`id`, `version`, `system`, `template`, `model`,
 * `variables`, `updatedAt`), retains full version history (`1, 2, 3...`), optionally persists
 * to `promptsFile`, and resolves `prompt_id` + `prompt_version` + `prompt_variables` across
 * `/v1/chat/completions`, `/v1/messages`, and `/v1/responses`.
 */
export class PromptRegistry {
  constructor(cfg = {}, { now = () => Date.now(), promptsFile = null } = {}) {
    this.now = now;
    this.promptsFile = promptsFile ?? cfg?.promptsFile ?? null;
    this.entries = new Map(); // id -> { id, latestVersion, versions: Map<number, VersionEntry> }

    this._loadFromConfig(cfg?.prompts);
    if (this.promptsFile) {
      this._loadFromFile(this.promptsFile);
    }
  }

  _nowIso() {
    const v = this.now();
    return v instanceof Date ? v.toISOString() : new Date(Number(v) || Date.now()).toISOString();
  }

  _loadFromConfig(rawPrompts) {
    if (!rawPrompts || typeof rawPrompts !== 'object') return;
    if (Array.isArray(rawPrompts)) {
      for (const item of rawPrompts) {
        if (item && typeof item === 'object' && item.id) {
          this._seedEntry(item.id, item);
        }
      }
      return;
    }
    for (const [id, spec] of Object.entries(rawPrompts)) {
      if (spec && typeof spec === 'object') {
        this._seedEntry(id, { ...spec, id });
      }
    }
  }

  _loadFromFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const mapObj = parsed?.prompts && typeof parsed.prompts === 'object' ? parsed.prompts : parsed;
      if (!mapObj || typeof mapObj !== 'object') return;
      for (const [id, record] of Object.entries(mapObj)) {
        if (!record || typeof record !== 'object') continue;
        if (Array.isArray(record.versions) && record.versions.length > 0) {
          for (const v of record.versions) {
            this._seedEntry(id, { ...v, id });
          }
        } else {
          this._seedEntry(id, { ...record, id });
        }
      }
    } catch {
      // Ignore corrupt or missing optional prompts file on startup.
    }
  }

  _persist() {
    if (!this.promptsFile) return;
    try {
      const dir = path.dirname(this.promptsFile);
      fs.mkdirSync(dir, { recursive: true });
      const out = {};
      for (const [id, entry] of this.entries.entries()) {
        out[id] = {
          id,
          latestVersion: entry.latestVersion,
          versions: [...entry.versions.values()],
        };
      }
      fs.writeFileSync(this.promptsFile, JSON.stringify({ prompts: out }, null, 2), 'utf8');
    } catch {
      // Best-effort persistence.
    }
  }

  _seedEntry(rawId, spec) {
    const id = String(rawId || spec?.id || '').trim();
    if (!id || !ID_PATTERN.test(id)) return null;
    const system = typeof spec.system === 'string' && spec.system.trim() ? spec.system : null;
    const template = typeof spec.template === 'string' && spec.template.trim() ? spec.template : null;
    if (!system && !template) return null;

    const extracted = extractTemplateVariables(system, template);
    const explicit = Array.isArray(spec.variables)
      ? spec.variables.map((v) => String(v).trim()).filter(Boolean)
      : [];
    const variables = [...new Set([...explicit, ...extracted])];

    let entry = this.entries.get(id);
    if (!entry) {
      entry = { id, latestVersion: 0, versions: new Map() };
      this.entries.set(id, entry);
    }

    const version =
      Number.isInteger(spec.version) && spec.version >= 1
        ? spec.version
        : entry.latestVersion + 1;

    const verObj = {
      id,
      version,
      system,
      template,
      model: typeof spec.model === 'string' && spec.model.trim() ? spec.model.trim() : null,
      variables,
      description: typeof spec.description === 'string' ? spec.description : null,
      updatedAt: typeof spec.updatedAt === 'string' && spec.updatedAt ? spec.updatedAt : this._nowIso(),
    };

    entry.versions.set(version, verObj);
    if (version > entry.latestVersion) {
      entry.latestVersion = version;
    }
    return verObj;
  }

  /**
   * Create a new prompt template or append a new version (`1, 2, 3...`) to an existing template.
   */
  upsert(spec = {}) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new LlmError('prompt payload must be a JSON object', {
        status: 400,
        type: 'invalid_request_error',
      });
    }
    const id = String(spec.id || '').trim();
    if (!id || !ID_PATTERN.test(id)) {
      throw new LlmError('prompt "id" is required and may only contain letters, digits, "_", ".", ":", "-"', {
        status: 400,
        type: 'invalid_request_error',
      });
    }
    const system = typeof spec.system === 'string' && spec.system.trim() ? spec.system : null;
    const template = typeof spec.template === 'string' && spec.template.trim() ? spec.template : null;
    if (!system && !template) {
      throw new LlmError('prompt must define at least one of "system" or "template"', {
        status: 400,
        type: 'invalid_request_error',
      });
    }

    const existing = this.entries.get(id);
    const nextVersion = existing ? existing.latestVersion + 1 : 1;
    const created = this._seedEntry(id, {
      ...spec,
      id,
      version: nextVersion,
      updatedAt: this._nowIso(),
    });
    this._persist();
    const entry = this.entries.get(id);
    return {
      ...created,
      latestVersion: entry.latestVersion,
      versionCount: entry.versions.size,
    };
  }

  /**
   * List latest version of all registered prompt templates.
   */
  list() {
    const out = [];
    for (const entry of this.entries.values()) {
      const latest = entry.versions.get(entry.latestVersion);
      if (latest) {
        out.push({
          ...latest,
          latestVersion: entry.latestVersion,
          versionCount: entry.versions.size,
        });
      }
    }
    return out;
  }

  /**
   * Retrieve a prompt template by `id` and optional `version` (defaults to `latestVersion`).
   */
  get(id, version = null) {
    const cleanId = String(id || '').trim();
    const entry = this.entries.get(cleanId);
    if (!entry) return null;

    let targetVer = entry.latestVersion;
    if (version !== null && version !== undefined && version !== '') {
      targetVer = Number(version);
      if (!Number.isInteger(targetVer) || targetVer < 1) return null;
    }

    const found = entry.versions.get(targetVer);
    if (!found) return null;

    return {
      ...found,
      latestVersion: entry.latestVersion,
      versionCount: entry.versions.size,
      versions: [...entry.versions.values()],
    };
  }

  /**
   * Delete a prompt template and all its versions by `id`.
   */
  delete(id) {
    const cleanId = String(id || '').trim();
    const deleted = this.entries.delete(cleanId);
    if (deleted) this._persist();
    return deleted;
  }

  /**
   * Resolve `prompt_id` (or `metadata.prompt_id`), `prompt_version`, and `prompt_variables`
   * on an incoming request body for `openai-chat`, `anthropic`, or `responses` faces.
   */
  applyToRequest(body, { face = 'openai-chat' } = {}) {
    if (!body || typeof body !== 'object') return null;
    const rawId = body.prompt_id ?? body.metadata?.prompt_id;
    if (rawId === undefined || rawId === null || rawId === '') return null;

    const promptId = String(rawId).trim();
    const rawVersion = body.prompt_version ?? body.metadata?.prompt_version ?? null;
    const vars = body.prompt_variables ?? body.metadata?.prompt_variables ?? {};

    if (vars !== null && (typeof vars !== 'object' || Array.isArray(vars))) {
      throw new LlmError('prompt_variables must be an object mapping variable names to values', {
        status: 400,
        type: 'invalid_request_error',
        code: 'invalid_prompt_variables',
      });
    }

    const prompt = this.get(promptId, rawVersion);
    if (!prompt) {
      const msg =
        rawVersion != null && rawVersion !== ''
          ? `prompt "${promptId}" version ${rawVersion} not found`
          : `prompt "${promptId}" not found`;
      const err = new LlmError(msg, {
        status: 404,
        type: 'not_found_error',
      });
      err.code = 'prompt_not_found';
      throw err;
    }

    const missing = (prompt.variables || []).filter(
      (v) => vars[v] === undefined || vars[v] === null,
    );
    if (missing.length > 0) {
      const err = new LlmError(
        `missing required prompt variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')} (for prompt "${prompt.id}" v${prompt.version})`,
        {
          status: 400,
          type: 'invalid_request_error',
        },
      );
      err.code = 'missing_prompt_variable';
      throw err;
    }

    const renderedSystem = prompt.system ? interpolateTemplate(prompt.system, vars) : null;
    const renderedTemplate = prompt.template ? interpolateTemplate(prompt.template, vars) : null;

    if (!body.model && prompt.model) {
      body.model = prompt.model;
    }

    if (face === 'openai-chat') {
      const msgs = Array.isArray(body.messages) ? [...body.messages] : [];
      if (renderedSystem) {
        msgs.unshift({ role: 'system', content: renderedSystem });
      }
      if (renderedTemplate) {
        msgs.push({ role: 'user', content: renderedTemplate });
      }
      body.messages = msgs;
    } else if (face === 'anthropic') {
      if (renderedSystem) {
        if (typeof body.system === 'string' && body.system.trim()) {
          body.system = `${renderedSystem}\n\n${body.system}`;
        } else if (Array.isArray(body.system)) {
          body.system = [{ type: 'text', text: renderedSystem }, ...body.system];
        } else {
          body.system = renderedSystem;
        }
      }
      const msgs = Array.isArray(body.messages) ? [...body.messages] : [];
      if (renderedTemplate) {
        msgs.push({ role: 'user', content: renderedTemplate });
      }
      body.messages = msgs;
    } else if (face === 'responses') {
      if (renderedSystem) {
        body.instructions =
          typeof body.instructions === 'string' && body.instructions.trim()
            ? `${renderedSystem}\n\n${body.instructions}`
            : renderedSystem;
      }
      if (renderedTemplate) {
        if (body.input === undefined || body.input === null || body.input === '') {
          body.input = renderedTemplate;
        } else if (typeof body.input === 'string') {
          body.input = `${renderedTemplate}\n\n${body.input}`;
        } else if (Array.isArray(body.input)) {
          body.input = [...body.input, { role: 'user', content: renderedTemplate }];
        }
      }
    }

    const resolved = {
      id: prompt.id,
      version: prompt.version,
      model: body.model || prompt.model || null,
    };
    body._resolvedPrompt = resolved;
    return resolved;
  }
}
