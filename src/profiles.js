/**
 * Built-in adapter profiles. `keysmith add cmd` copies one of these into your config;
 * every field stays yours to edit, so a profile is a starting config, not an opaque
 * plugin. Fields marked "verified" were read off the live tools listed in `provenance`.
 */

/**
 * agy's own agent format, verified on agy 1.3.3: markdown with YAML frontmatter, the H1
 * section is the system prompt. Measured on a one-word answer (gemini-3.8-flash-low):
 * default agent 20,107 input tokens; `tools: []` alone 10,488; plus `inheritMcp: false`,
 * `inheritCustomizations: false` (your GEMINI.md, skills, rules) and
 * `excludeDefaultComponents: true` (agy's built-in harness sections) 585 with a one-line
 * system prompt, about 700 with the one below.
 * A plain-text request is all an API client can send, so that is all this agent does.
 *
 * `tools: []` leaves one tool behind: agy attaches `manage_task` (its background-task
 * manager) to every agent, and nothing in the agent format removes it. A model that has
 * just written a command sometimes calls it to "check on" that command, is told there is
 * no task, and answers a second time. In three direct runs of one replayed shell-agent
 * request two called it: one before writing anything (harmless, the answer followed), one
 * after its answer, which it then wrote again. The prompt names the tool, and
 * `stopAtToolCall` on the profile ends the run at the first such call after the answer.
 * (The same request also ran to agy's 280 s print timeout in 2 of 9 calls. That was not
 * this tool: both were one response step that kept writing past its answer, as if it were
 * the rest of the transcript. `stopAtToolCall` does not end those.)
 */
const AGY_TEXT_AGENT_NAME = 'keysmith-text';
const AGY_TEXT_AGENT = `---
name: ${AGY_TEXT_AGENT_NAME}
description: Plain text completions for keysmith. No tools.
tools: []
mainAgent: true
subagent: false
hidden: true
inheritMcp: false
inheritCustomizations: false
excludeDefaultComponents: true
---

# ${AGY_TEXT_AGENT_NAME}

You are a language model answering one request through an API. You have no tools here: you cannot run commands, read or write files, browse, or call functions. Your text is the whole answer.

Follow the request's own instructions. If it asks you to run, inspect or change something, do not refuse and do not try to do it yourself: write the commands, code or answer as text, in exactly the format the request asks for. Whoever sent the request acts on what you write.

Nothing you write is run while you answer, so there is never a task to wait for or check on: do not call \`manage_task\` or any other function. Answer once, then stop.
`;
const AGY_TOOL_DENIAL_RETRY =
  'Your previous answer to this request was a tool call, and it was refused: there are no tools here, so it produced nothing. ' +
  'Answer again in plain text only, with no tool or function calls. If the request asks for something to be run, read or changed, ' +
  'write the commands or code out as text in the format the request asks for.';

export const CLI_PROFILES = {
  cmd: {
    kind: 'cli',
    bin: 'cmd',
    // `--no-session` is filled in by the adapter and disappears when persistSessions
    // is on, so one template covers stateless and resumable modes.
    args: ['-p', '{noSession}', '--output-format', 'json', '--max-turns', '1', ['--model', '{model}'], '{prompt}'],
    resumeArgs: ['-p', '--output-format', 'json', '--max-turns', '1', '--resume', '{session}', '{prompt}'],
    persistSessions: false,
    parser: 'cmd-ndjson',
    modelsFrom: { args: ['--list-models'] },
    timeoutMs: 300_000,
    maxConcurrent: 1,
    provenance: 'Command Code 1.66.0 — `cmd -p --output-format json` emits text_delta events then a result line',
    note: 'cmd adds its own ~16k-token agent prompt to every call and bills it. That is the price of renting its harness; keep --max-turns 1 unless you want it editing files.',
  },
  opencode: {
    kind: 'cli',
    bin: 'opencode',
    args: ['run', '--format', 'json', '--pure', '--auto', ['--model', '{model}'], '{prompt}'],
    resumeArgs: ['run', '--format', 'json', '--pure', '--auto', '--session', '{session}', '{prompt}'],
    persistSessions: true,
    parser: 'opencode-ndjson',
    modelsFrom: { args: ['models'] },
    timeoutMs: 300_000,
    maxConcurrent: 2,
    provenance: 'opencode 1.18.27 — `opencode run --format json` emits step_start / text / step_finish',
    note: 'Model ids are provider/model as opencode resolves them, so any provider you wired into opencode is reachable through keysmith for free — including the CLI-to-CLI case of serving opencode-configured keys to apps that only speak HTTP.',
  },
  qoder: {
    kind: 'cli',
    bin: 'qodercli',
    args: ['-p', '{noSession}', ['--model', '{model}'], '{prompt}'],
    resumeArgs: ['-p', '--resume', '{session}', '{prompt}'],
    persistSessions: false,
    parser: 'raw',
    modelsFrom: { args: ['--list-models'] },
    timeoutMs: 300_000,
    maxConcurrent: 1,
    provenance: 'Qoder CLI 1.1.59 — `qodercli -p` prints the answer and that is the only output mode verified from here',
    note: 'Set QODER_* entrypoint vars aside (`keysmith serve` clears them) or the CLI exits 42 before it answers. `-o json` / `-o stream-json` also exit 42 with no output inside a nested agent session — those vars are how it finds its credentials — so `raw` is the default. If you run keysmith from a plain login shell, try `-o stream-json` with parser `claude-stream-json` for token counts and resume.',
  },
  claude: {
    kind: 'cli',
    bin: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose', '{noSession}', '--max-turns', '1', ['--model', '{model}'], '{prompt}'],
    resumeArgs: ['-p', '--output-format', 'stream-json', '--verbose', '--resume', '{session}', '{prompt}'],
    persistSessions: false,
    parser: 'claude-stream-json',
    modelsFrom: null,
    timeoutMs: 300_000,
    maxConcurrent: 1,
    provenance: 'Claude Code 2.1.261 — every flag here is accepted by `claude --help` (`--max-turns` is undocumented but parsed), and the stream-json `result` line carries usage/session_id',
    note: 'Declare `models: ["sonnet", "opus"]` or pass the id through; Claude Code has no offline model listing. A failed run prints one `result` line with is_error and the reason in `errors[]` — the parser surfaces it rather than returning an empty completion.',
  },
  agy: {
    kind: 'cli',
    bin: 'agy',
    // `-p` takes the prompt as its own value, so it goes last: anything after it is read as
    // the prompt (agy refuses `-p --output-format …` rather than guessing).
    // `--agent keysmith-text` is the tool-less agent below. Without it every call is agy's
    // full coding agent: a ~20k-token harness prompt, every MCP server booted, and tools
    // that headless mode then refuses, so a model that reaches for one answers nothing.
    args: ['--output-format', 'stream-json', '--disable-slash-commands', '--print-timeout', '280s', '--agent', AGY_TEXT_AGENT_NAME, ['--model', '{model}'], '-p', '{prompt}'],
    resumeArgs: ['--output-format', 'stream-json', '--disable-slash-commands', '--print-timeout', '280s', '--conversation', '{session}', '--agent', AGY_TEXT_AGENT_NAME, ['--model', '{model}'], '-p', '{prompt}'],
    // agy writes every run to disk as a conversation whether asked or not; there is no
    // flag to stop it, so the honest setting is "sessions persist" and resume works.
    persistSessions: true,
    parser: 'agy-stream-json',
    modelsFrom: { args: ['models'] },
    // An empty directory keysmith owns: headless agy may read inside its workspace, and
    // nothing in it is the workspace you are standing in. agy finds project agents in
    // `.agents/agents/` under its cwd, so the tool-less agent lives there and is rewritten
    // whenever it drifts — an agent name agy cannot find is silently the full harness.
    cwd: '~/.local/share/keysmith/workspaces/agy',
    workspaceFiles: { [`.agents/agents/${AGY_TEXT_AGENT_NAME}.md`]: AGY_TEXT_AGENT },
    toolDenialRetry: AGY_TOOL_DENIAL_RETRY,
    // agy keeps `manage_task` on every agent; after the answer, a call to it is the model
    // starting over. The answer ends there.
    stopAtToolCall: true,
    timeoutMs: 300_000,
    maxConcurrent: 2,
    provenance: 'Antigravity CLI (agy) 1.3.3 — `agy --output-format stream-json -p` emits init / step_update (agent_response text_delta, per-step usage) / result; `agy models` prints id<TAB>name; `--conversation <id>` resumes; `--agent <name>` loads a markdown agent from `.agents/agents/` (unknown names fall back to the default agent without an error)',
    note: 'Uses your Antigravity login, no key. Runs agy as the tool-less `keysmith-text` agent: ~600 input tokens for a one-word answer instead of the default agent\'s ~20k, no MCP servers booted, no tools to be refused. If a model still answers with a refused tool call, keysmith retries once with a stricter instruction (logged, and counted as `retries` in the usage log). agy keeps one tool, `manage_task`, on every agent: once the answer has text, a call to it ends the run (`stopAtToolCall`, `cutAt` in the usage log) instead of producing a second answer. For agy\'s full coding agent drop `--agent keysmith-text` from args/resumeArgs and set `stopAtToolCall` to false — you get its harness prompt, MCP start-up and headless tool refusals back. Each run leaves a conversation under ~/.gemini/antigravity-cli/conversations.',
  },
  codex: {
    kind: 'cli',
    bin: 'codex',
    args: ['exec', '--skip-git-repo-check', ['--model', '{model}'], '{prompt}'],
    parser: 'raw',
    modelsFrom: null,
    timeoutMs: 300_000,
    maxConcurrent: 1,
    provenance: 'Codex CLI non-interactive exec — argv shape from its documented interface, not run against a live install',
    note: 'No model discovery — declare models in the adapter entry. Not verified end to end: run `keysmith doctor` after adding it and expect to edit `args` once or twice.',
  },
  gemini: {
    kind: 'cli',
    bin: 'gemini',
    args: ['-p', '{prompt}', ['--model', '{model}']],
    parser: 'raw',
    modelsFrom: null,
    timeoutMs: 300_000,
    maxConcurrent: 2,
    provenance: 'Gemini CLI one-shot print mode — argv shape from its documented interface, not run against a live install',
    note: 'Nothing but the answer reaches stdout in print mode, so `raw` is the right parser and there are no token counts. Declare `models` or rely on the CLI default.',
  },
};

/**
 * Plain HTTP upstreams. These exist because a gateway that only bridges CLIs is a
 * worse bridge: keep one direct route to a real API and failover can skip the CLI
 * when it is slow, cold or out of quota.
 */
export const HTTP_PROFILES = {
  openai: { kind: 'http', wire: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '{env:OPENAI_API_KEY}' },
  anthropic: { kind: 'http', wire: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: '{env:ANTHROPIC_API_KEY}' },
  openrouter: { kind: 'http', wire: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '{env:OPENROUTER_API_KEY}' },
  groq: { kind: 'http', wire: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: '{env:GROQ_API_KEY}' },
  deepseek: { kind: 'http', wire: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: '{env:DEEPSEEK_API_KEY}' },
  together: { kind: 'http', wire: 'openai', baseUrl: 'https://api.together.xyz/v1', apiKey: '{env:TOGETHER_API_KEY}' },
  ollama: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: false, priority: 50 },
  lmstudio: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: false, priority: 50 },
  llamacpp: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: false, priority: 50 },
  vllm: { kind: 'http', wire: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: false, priority: 50 },
  copilot: {
    kind: 'http',
    wire: 'openai',
    baseUrl: 'https://api.githubcopilot.com',
    apiKey: '{env:COPILOT_API_TOKEN}',
    headers: { 'editor-version': 'vscode/1.104.1', 'copilot-integration-id': 'vscode-chat', 'openai-intent': 'chat' },
    priority: 60,
    provenance: 'api.githubcopilot.com, OAuth device token (ghu_…) verified against /models and /chat/completions',
    note: 'Copilot answers /chat/completions, but /models lists far more than your plan will actually run — the premium ids reply model_not_supported. `keysmith doctor --probe-models` finds the truth; declare that subset under `models` to keep the picker honest.',
  },
};

export function getProfile(name) {
  return CLI_PROFILES[name] || HTTP_PROFILES[name] || null;
}

export function profileNames() {
  return [...Object.keys(CLI_PROFILES), ...Object.keys(HTTP_PROFILES)];
}
