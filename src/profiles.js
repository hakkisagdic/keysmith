/**
 * Built-in adapter profiles. `keysmith add cmd` copies one of these into your config;
 * every field stays yours to edit, so a profile is a starting config, not an opaque
 * plugin. Fields marked "verified" were read off the live tools listed in `provenance`.
 */

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
