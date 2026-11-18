# keysmith MCP Server

keysmith includes a local Model Context Protocol (MCP) server over **stdio JSON-RPC 2.0** (`stdin`/`stdout`, newline-delimited JSON) for inspecting and managing configured sources on **this Mac only**. There is no HTTP listener, no tunnel exposure, and no remote access.

## Command

```bash
keysmith mcp                 # run the stdio MCP server (used by MCP clients)
keysmith mcp --register      # register keysmith in supported local MCP clients
keysmith mcp --register --dry-run
```

- Supported MCP protocol versions: `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` (negotiates the client's requested version when supported, otherwise `2025-11-25`).
- Server identity & capabilities: `serverInfo: { "name": "keysmith", "version": "0.1.0" }`, `capabilities: { "tools": { "listChanged": false } }`.
- JSON-RPC methods handled: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
- Reads config from `~/.config/keysmith/config.json` (`$KEYSMITH_CONFIG`) and runtime/usage state from `~/.local/share/keysmith/` (`$KEYSMITH_DATA`). Inspecting config never runs `{exec:…}` commands.

## Client registration (`--register`)

`keysmith mcp --register` (`--setup` is accepted as an alias) uses the same registration step as `keyflip --register`. It resolves the Node binary with `stablePath(process.execPath)` (rewriting fnm multishell/default shims to `<fnm>/aliases/default/…` and Homebrew Cellar kegs to `…/opt/<formula>/…` so version upgrades do not break client configs) and registers `"keysmith"` running `["/path/to/keysmith/src/cli.js", "mcp"]`.

It inspects **only** these 6 clients, touching a client **only** when its config file or parent directory already exists:

| Client | Config file | Detection rule | Entry written |
|---|---|---|---|
| `claude-code` | `~/.claude.json` | `~/.claude.json` or `~/.claude/` exists | `mcpServers.keysmith = { command, args }` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS; `~/.config/Claude/claude_desktop_config.json` elsewhere) | file or parent dir exists | `mcpServers.keysmith = { command, args }` |
| `cursor` | `~/.cursor/mcp.json` | file or `~/.cursor/` exists | `mcpServers.keysmith = { command, args }` |
| `gemini-cli` | `~/.gemini/settings.json` | file or `~/.gemini/` exists | `mcpServers.keysmith = { command, args }` |
| `opencode` | `~/.config/opencode/opencode.json` | file or `~/.config/opencode/` exists | `mcp.keysmith = { type: "local", command: [command, ...args], enabled: true }` |
| `codex-cli` | `~/.codex/config.toml` | file or `~/.codex/` exists | `[mcp_servers.keysmith]` with `command` and `args` |

Registration guarantees:

- **Preserves existing configuration:** unrelated keys and existing MCP servers in JSON and TOML files are kept intact.
- **Idempotent:** if `keysmith` is already registered with the same `command` and `args`, no backup or write occurs (`= <client> (<file>): already registered`).
- **Backup-first atomic writes:** before modifying an existing config file, writes a mode-`0600` dated backup (`<file>.bak-<YYYYMMDD-HHMMSS>-mcp`, never overwriting an existing backup), then writes atomically via a mode-`0600` temp file and `rename`.
- **Safe skipping:** unreadable or malformed JSON files are skipped without echoing file contents (`! <client> (<file>): skipped — <reason>`).
- **Dry run & manual fallback:** `--dry-run` prints planned edits without writing; if none of the 6 client configs or directories exist, it writes nothing and prints a manual `mcpServers` JSON snippet.

## Tool conventions

- **Naming:** every tool is named `keysmith_<verb>`.
- **Annotations:**
  - Read-only tools advertise `{ "readOnlyHint": true, "destructiveHint": false }`.
  - All write tools and `keysmith_reload` advertise `{ "readOnlyHint": false, "destructiveHint": true }`.
- **Strict schemas:** every tool uses `type: "object"` with `additionalProperties: false`. Harness-injected `toolSummary` and `toolAction` arguments are stripped before dispatch unless declared on the tool schema.
- **Confirmation gate (`confirm: true`):** every writing/reload tool declares `confirm: { type: "boolean" }` and is checked centrally in `src/mcp.js` before its handler runs. Calling without `confirm: true` (omitted, `false`, `"true"`, or `1`) returns `isError: true` with `structuredContent: { ok: false, error: "confirmation_required", tool, message }`, leaving `config.json` untouched and creating no backup. Ask the user for confirmation first and pass `confirm: true` only after explicit approval.
- **Backup-first atomic config writes:** config-writing tools serialize through an in-process write queue, validate the updated adapter entry (`checkAdapter`), copy `config.json` to a mode-`0600` dated backup first (`config.json.bak-<YYYYMMDD-HHMMSS>-mcp`, or `-source` via `keysmith_source_add`, which also backs up an existing `catalogue.json`), and write through a mode-`0600` temp file + `rename`. No-op calls (`changed: false`) write nothing and create no backup (`backup: null`). Because the gateway loads `config.json` at start, successful config mutations return `reloadRequired: true`; run `keysmith_reload` (with `confirm: true`) to restart the LaunchAgent.
- **Structured output:** every call returns both `content: [{ type: "text", text }]` (JSON text) and `structuredContent`.

## Read tools (`readOnlyHint: true`, `destructiveHint: false`)

### `keysmith_ping`

Checks that the MCP server is reachable and returns non-sensitive config summary counts.

- **Arguments:** `{}`
- **Returns:** `{ ok, server, version, configLoaded, configError?, authEnabled, adapterCount, aliasCount }`

### `keysmith_status`

Reports gateway launchd state, PID, port, `/healthz` check, and configured source counts.

- **Arguments:** `{}`
- **Returns:** `{ ok, configLoaded, configError?, running, pid, port, enabledSources, disabledSources, totalSources, launchd, healthz }`
  - `launchd`: `{ label: "dev.keysmith.gateway", state ("running" | "loaded" | "not_loaded" | "unsupported"), loaded, pid, tunnel: { label: "dev.keysmith.tunnel", loaded, pid } }`
  - `healthz`: when the gateway is running, probes `GET http://127.0.0.1:<port>/healthz` (`ok`, `reachable`, `httpStatus`, `uptimeSeconds?`, `adapters?`, `failedToLoad?`, `aliasWarnings?`, `error?`); when not running, skips network probes (`ok: false, reachable: false, httpStatus: null, reason: "not_running"`).

### `keysmith_sources`

Lists configured sources with non-secret metadata, key reference kind, and Keychain presence, plus built-in free-tier profiles.

- **Arguments:** `{ includeDisabled?: boolean }` (default `true`)
- **Returns:** `{ ok, configLoaded, sources, profiles }`
  - Each `sources[]` item: `{ id, kind ("http" | "cli"), wire, baseUrl, disabled, explicitOnly, modelsOnly, freeOnly, modelCount, keyRefType ("exec" | "json" | "file" | "dotenv" | "env" | "literal" | "none"), keychainExists ("yes" | "no") }`
  - `baseUrl` strips embedded credentials, query strings, and hashes, and redacts Cloudflare `/accounts/<id>` path segments.
  - `keychainExists` queries Keychain item attributes only (`security find-generic-password` without `-w`) and never reads secret values.
  - `profiles[]`: `{ id, attached, freeOnly, note? }` for `tokenrouter`, `groq`, `mistral`, and `cloudflare`.

### `keysmith_source_models`

Inspects one source's configured models, approval flags, and difference against the cached discovered free list.

- **Arguments:** `{ source: string }` (`required: ["source"]`)
- **Returns:** `{ ok, source, modelsOnly, freeOnly, configuredModels, models, discovery }`
  - `models[]`: `{ id, approved (modelsOnly && configured), status ("approved" | "unapproved"), configured, discoveredFree (boolean | null) }`
  - `discovery`: `{ available, message, discoveredFree, diff: { onlyInDiscovered, onlyInModels } }` comparing `configuredModels` with `<dataDir>/discovered/<source>.json` (populated by `keysmith discover` when `discovery.enabled` is true).

### `keysmith_test`

Runs a non-destructive health check on a single configured source without reading or returning HTTP bodies.

- **Arguments:** `{ source: string }` (`required: ["source"]`)
- **Returns:** `{ ok, source, kind, status, httpStatus, latencyMs, disabled?, error? }`
  - For `cli` sources: checks `PATH` for the configured binary (`status: "ok" | "binary_missing"`).
  - For `http` sources: resolves credentials, sends `GET <baseUrl>/models` (or `/api/traycer/models` for `wire: "traycer"`), immediately cancels the response stream (`res.body?.cancel?.()`) without reading or returning any body, and reports latency plus classified status (`"ok"`, `"unauthorized"`, `"no_models_endpoint"`, `"rate_limited"`, `"http_error"`, `"unreachable"`, `"missing_credentials"`, `"invalid_credentials"`, `"invalid_config"`, `"disabled"`).

### `keysmith_usage`

Reports per-source requests, token counts, spend, and remaining headroom to configured `limits.spend` caps.

- **Arguments:** `{ source?: string, since?: string, until?: string, hours?: number }`
- **Returns:** `{ ok, since, until, totals: { requests, failures, refused, tokens, spendUsd, listUsd }, sources, readErrors? }`
  - Each `sources[]` item: `{ id, requests, failures, refused, tokens: { input, output, cacheRead, cacheWrite, total } | null, spendUsd, listUsd, remainingHeadroomUsd, spendCap }`
  - Matches `limits.spend` caps by adapter id and credential `account`, selecting the tightest remaining headroom (`remainingHeadroomUsd`) and reporting `{ scope, capUsd, spentUsd, remainingUsd, exceeded, month?, resetAt?, window?, windowStatus?, error? }` in `spendCap`.

### `keysmith_approved`

Returns approved models (`modelsOnly: true` sources) and pending "free flag changed" catalogue review entries.

- **Arguments:** `{ source?: string }`
- **Returns:** `{ ok, configLoaded, approved, pending }`
  - `approved`: `{ [source]: string[] }` mapping for sources with `modelsOnly: true`.
  - `pending`: array of `{ source, model, oldFree, newFree }` entries derived from `catalogue.json`, cached `<dataDir>/discovered/<source>.json`, and configured model baselines.

## Write & reload tools (`readOnlyHint: false`, `destructiveHint: true`, all require `confirm: true`)

### `keysmith_source_add`

Attaches a built-in source profile (`tokenrouter`, `groq`, `mistral`, `cloudflare`) using Keychain service/account **names** only (never a key value).

- **Prerequisite:** store the API key in macOS Keychain first from your terminal:
  ```bash
  security add-generic-password -s groq-api -a keysmith -w
  ```
- **Arguments:** `{ profile: string, keyRef: string, keyAccount?: string, as?: string, models?: string[], accountId?: string, force?: boolean, confirm: true }` (`required: ["profile", "keyRef"]`)
  - `keyRef`: Keychain service name (`-s`), never a key value or `{…}` reference.
  - `keyAccount`: Keychain account name (`-a`, defaults to `"keysmith"`).
  - `as`: custom adapter id (defaults to `profile`).
  - `models`: initial model ids to allow. For non-`freeOnly` profiles (`groq`, `mistral`, `cloudflare`), omitting `models` selects a default small chat model from the provider's `/models` endpoint.
  - `accountId`: 32-hex Cloudflare account id (required only for `cloudflare`; never echoed back).
  - `force`: overwrite an existing source entry with the same id.
- **Safety & behavior:** refuses requests carrying raw secret fields (`apiKey`, `key`, `secret`, `keyValue`) or secret-shaped / `{…}` values in `keyRef`/`keyAccount`; verifies the Keychain item exists before modifying anything; writes `apiKey` as `{exec:/usr/bin/security find-generic-password -s <service> -a <account> -w}` with `explicitOnly: true`, `freeOnly: true` (`tokenrouter`) or `modelsOnly: true` (named-model profiles), enables `discovery.enabled`, updates `catalogue.json` and `config.json` with `0600` backups, and returns `{ ok, changed: true, source, profile, disabled, explicitOnly, freeOnly, modelsOnly, models, keyRefType: "exec", catalogueUpdated: true, backup, reloadRequired: true, note? }`.

### `keysmith_source_enable` / `keysmith_source_disable`

Enables (`disabled: false`) or disables (`disabled: true`) an attached source with a backup-first atomic write, preserving its key reference and all other adapter fields.

- **Arguments:** `{ source: string, confirm: true }` (`required: ["source"]`)
- **Restrictions:** `keysmith_source_enable` refuses sources marked `unsafeTools: true`.
- **Returns:** `{ ok, changed, source, field: "disabled", previousDisabled, disabled, backup, reloadRequired }`

### `keysmith_source_set_models`

Replaces an attached source's `models` list while keeping `modelsOnly: true`.

- **Arguments:** `{ source: string, models: string[], confirm: true }` (`required: ["source", "models"]`)
- **Behavior:** deduplicates model ids and preserves per-model metadata objects when `models` was configured as an object or array of `{ id, … }` objects.
- **Returns:** `{ ok, changed, source, modelsOnly: true, previousModels, models, added, removed, backup, reloadRequired }`

### `keysmith_model_approve` / `keysmith_model_revoke`

Adds (`keysmith_model_approve`) or removes (`keysmith_model_revoke`) a single model id on an attached source while keeping `modelsOnly: true`.

- **Arguments:** `{ source: string, model: string, confirm: true }` (`required: ["source", "model"]`)
- **Returns:** `{ ok, changed, source, model, approved, modelsOnly, models, backup, reloadRequired }`

### `keysmith_reload`

Restarts the macOS `launchd` gateway LaunchAgent (`dev.keysmith.gateway`), warns if requests are in flight, and waits for `/healthz`.

- **Arguments:** `{ confirm: true }`
- **Prerequisites:** macOS with `~/Library/LaunchAgents/dev.keysmith.gateway.plist` installed (`keysmith install-service`).
- **Behavior:** checks active in-flight requests before restarting (via `/healthz` or gateway child process count), runs `launchctl bootout` followed by `launchctl bootstrap` (retrying while launchd releases the old process), and polls `GET /healthz` until `ok: true` (up to 15 s).
- **Returns:** `{ ok, restarted, label: "dev.keysmith.gateway", previousPid, pid, pidChanged, port, healthzStatus, healthz, latencyMs, inFlight, inFlightWarning, enabledSources, disabledSources, totalSources }`

## Never returned

Every tool response and error message passes through `redactMcpValue` / `redactMcpText` (`src/mcp.js`) and `src/redact.js` (`redactSecrets`). The MCP server never returns:

- **Key values:** minted gateway keys (`ks_…`), upstream API keys, `Bearer` tokens, auth headers (`Authorization`, `x-api-key`, `x-goog-api-key`, etc.), or secret `env` values (including 12+ character fragments of configured secrets).
- **Secret reference interiors:** `{exec:…}`, `{json:…}`, `{file:…}`, and `{dotenv:…}` are masked to `{exec:[redacted]}`, `{json:[redacted]}`, `{file:[redacted]}`, `{dotenv:[redacted]}` — Keychain service/account names, file paths, and JSON/dotenv keys inside references are never returned (`{env:VAR}` variable names are not secrets).
- **`auth.keys[].key`:** redacted to `ks_Q…35 fp:…` via `redactKey`.
- **Cloudflare account ID:** `accountId` / `account_id` fields and `/accounts/<32-hex>` URL segments are replaced with `[redacted]`.
- **`workspaceFiles` content:** file names are preserved while contents are replaced with `[redacted]` and scrubbed verbatim.
- **Request and response bodies:** `keysmith_test` cancels the HTTP response stream unread, and `requestBody` / `responseBody` / `reqBody` / `resBody` / `rawBody` / `body` values (or inline fragments in error strings) are replaced with `[redacted]`.
- **Backup directory paths in write/reload responses:** `backup` reports only the backup filename (basename), and home/config/data directory prefixes are shortened.

## Non-goals

- No web UI.
- No remote access (stdio on this Mac only; never served over TCP or a Cloudflare tunnel).
- No key generation and no provider signup.
- No new admin HTTP API.
- No management of `aliases`, `virtualModels`, `tunnel`, or `auth.keys` (manage those with the `keysmith` CLI).
