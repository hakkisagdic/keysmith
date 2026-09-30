# keysmith

**Forge an API key out of any coding CLI.**

You already pay for Command Code, opencode, Claude Code, Qoder, Copilot — and their
credentials are logins, not keys. Apps that only speak `Authorization: Bearer` cannot
use them. keysmith runs each CLI once per request, reads its event stream, and serves
the result as an OpenAI-compatible endpoint:

```
POST /v1/chat/completions   { "model": "cmd/evren/glm-5.3", ... }        →  cmd -p …
POST /v1/chat/completions   { "model": "evren/gpt-4.1", ... }            →  direct HTTP
POST /v1/chat/completions   { "model": "cheap", ... }                    →  alias chain, in order
```

One config file, one port, one key. Zero dependencies — Node 20+ and nothing else.

```bash
git clone https://github.com/hakkisagdic/keysmith.git && cd keysmith
node src/cli.js init                 # writes ~/.config/keysmith/config.json (0600) + one API key
node src/cli.js add cmd              # attach a built-in profile
node src/cli.js add evren --base-url https://your-gateway/v1 --key '{json:~/.local/share/opencode/auth.json#evren.key}'
node src/cli.js doctor               # is each adapter actually alive, and what does it cost
node src/cli.js serve --tunnel       # http://127.0.0.1:8787/v1 (+ Cloudflare tunnel)
```

Point anything at it:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEYSMITH_KEY" -H 'content-type: application/json' \
  -d '{"model":"cmd/gpt-5","stream":true,"messages":[{"role":"user","content":"one-line haiku"}]}'
```

---

## Should you actually do this?

Honest tradeoffs, because a CLI behind an HTTP port is not free:

| | HTTP adapter (a real API) | CLI adapter (a rented agent) |
|---|---|---|
| Tokens you're billed | the ones you sent | yours **plus the harness's own system prompt** |
| Latency | first token in a few hundred ms | process spawn + agent boot, typically +1–3 s |
| Tool calls | forwarded verbatim | the CLI runs them itself, it will not hand them back |
| Concurrency | many | low — one process is one agent |
| State | stateless | the CLI keeps a session on disk; keysmith maps it |

Command Code is the clearest case: every call carries roughly a 16 000-token agent
prompt that is billed to you. That is the price of renting its harness — the upside is
that a subscription you already pay for becomes usable from a phone app, a IDE plugin,
or a script that only knows `/v1`. keysmith reports what the upstream actually charged,
never what you wished it charged; `keysmith usage` is the place to see it.

So: prefer an HTTP adapter when you have one. Use a CLI adapter for the credentials that
would otherwise be trapped inside a terminal. And keep an alias chain that mixes both —
that is the interesting part.

## What it gives you

| Route | Notes |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions, streaming and not |
| `POST /v1/messages` | Anthropic Messages, for Claude Code and friends |
| `POST /v1/responses` | OpenAI Responses (Codex-style `input` arrays) |
| `POST /v1/embeddings` | forwarded to HTTP adapters only |
| `GET /v1/models` | the whole catalogue, namespaced; `?refresh` re-queries |
| `GET /v1/keysmith/routes` | adapters, aliases and limits as JSON |
| `GET /v1/keysmith/usage?hours=24&tail=50` | request counts per model, latest entries |
| `GET /` | status page in a browser (`?api_key=…`, same key as the API) |
| `GET /healthz` | keyless liveness probe for a supervisor |

Everything under `/v1` needs `Authorization: Bearer <key>`, `x-api-key`, or `?api_key=`.
CORS is open, so browser apps can call it directly.

## Models are namespaced

`<adapter>/<upstream model>` — only the **first** slash separates, because upstream ids
contain slashes of their own (`openrouter/deepseek/deepseek-v4-flash`,
`oc/evren/glm-5.3`). A bare id with no slash routes to the adapter of that name, so
`cmd` alone means "cmd's default model".

```bash
keysmith models --refresh    # what this gateway exposes, and from where
```

## Aliases: failover, and the cheapest route that works

```json
"aliases": {
  "cheap": ["evren/deepseek-v4-flash", "ollama/qwen3:4b", "oc/evren/deepseek-v4-flash"]
}
```

Declared order wins. keysmith tries the next candidate **only while nothing has reached
the client** — a half-delivered answer is never restarted, because the user already saw
part of it. That makes aliases safe to point at a laptop's whole toolchain: a direct API
first, a local model second, an agent CLI last.

Per-adapter knobs that shape a route: `priority` (orders the flat listing), `disabled`,
`timeoutMs`, `maxConcurrent` (a semaphore, so five browser tabs cannot fork five agents),
`stripSystemPrompt`, `maxPromptChars`, `headers`, `modelMap`, `defaultModel`.

## Sessions: multi-turn out of a stateless client

OpenAI clients resend history; CLIs *are* stateful. keysmith hands back an opaque
`kss_…` id (in the body, in `x-keysmith-session`, and in the last SSE chunk) and maps it
onto the upstream session — `cmd --resume`, `opencode --session`. Send it back on the
next request and the CLI continues its own thread, which is also how you get prompt
caching. Sessions live in memory: restart the gateway and clients start fresh.

## Tool calls, thinking

`tools`/`tool_choice` pass straight through to the first HTTP candidate in the chain.
If none can take them, keysmith logs it and runs a plain completion rather than
pretending a CLI produced `tool_calls`.

A CLI that emits thinking (`cmd`, Claude, opencode) keeps it to itself unless the request
says `"include_reasoning": true` — then it arrives as `delta.reasoning_content` on
`/v1/chat/completions`. The other two faces drop it.

## Secrets stay out of the config

An adapter's `apiKey` is a *reference*, resolved at load and never written to a log:

```json
"{env:OPENAI_API_KEY}"
"{file:~/.config/keys/copilot}"
"{json:~/.local/share/opencode/auth.json#evren.key}"
"{exec:security find-generic-password -s copilot-api -w}"
"sk-live-…"
```

The `{json:…}` form is the one that matters: it reuses a credential an agent already
keeps in its own store, so you never paste a key twice and nothing secret lands in this
repo. A literal works too, but the file is `0600` for a reason.

## Publishing it safely

`keysmith serve --tunnel` is the whole point for remote clients, and a tunnel is
transport, not authentication — the key still gates every request. Two modes:

```bash
brew install cloudflared
cloudflared tunnel login
keysmith tunnel setup llm.example.com          # prints what it will do
keysmith tunnel setup llm.example.com --yes    # tunnel create + route dns + ingress YAML
```

That is a **named** tunnel: stable hostname, survives restarts, ingress file you can
keep in a repo. Without it, keysmith falls back to a quick tunnel and says so — a
`trycloudflare.com` hostname is random and dies with the process, which is how a
"working endpoint" becomes three dead entries in someone's client config. Use named
tunnels for anything you paste into a client you will not reopen. Details:
[docs/tunnel.md](docs/tunnel.md).

Keep `host: 127.0.0.1`. There are no rate limits here, and a CLI adapter is a process
spawner: an unauthenticated public gateway is a denial-of-wallet machine.

## Built-in profiles

| Profile | Kind | Status |
|---|---|---|
| `cmd` | cli | verified live against Command Code 1.66.0 |
| `opencode` | cli | verified live against opencode 1.18.27 |
| `qoder` | cli | verified with `-p`; its `-o json/stream-json` modes fail inside a nested agent session |
| `claude` | cli | flags and stream-json shape checked against Claude Code 2.1.261 |
| `codex`, `gemini` | cli | documented argv shape, not run against a live install |
| `openai`, `anthropic`, `openrouter`, `groq`, `deepseek`, `together` | http | standard endpoints |
| `ollama`, `lmstudio`, `llamacpp`, `vllm` | http | local servers, no key |
| `copilot` | http | verified live against `api.githubcopilot.com` with an OAuth device token |

`keysmith adapters` lists them; `keysmith add <profile>` copies one into your config
where every field stays yours. Adding an agent nobody has heard of is a config edit:

```bash
keysmith add custom --as myagent --bin myagent --args '["-p","{prompt}"]' --parser raw
```

The argv template supports `{model}`, `{prompt}`, `{system}`, `{session}`,
`{maxTokens}` and `{noSession}`; a nested array is a group that disappears when its
placeholder is empty (so `-m` can never swallow your prompt). Full field reference and
the parser contract: [docs/adapters.md](docs/adapters.md).

## Client recipes

Warp, Claude Code, opencode, Codex, Qoder, `openai` Python — copy-paste config in
[docs/clients.md](docs/clients.md).

## Development

```bash
npm test          # 39 tests: parsers, routing, and an HTTP suite against a stub CLI
node src/cli.js doctor --probe-models   # the truth about which models answer (spends quota)
```

The integration suite spawns a stub script that prints Command-Code-shaped NDJSON, so
spawning, parsing, SSE framing, session mapping and failover are covered without
touching a provider or spending a token.

Config: `~/.config/keysmith/config.json` (`$KEYSMITH_CONFIG`).
State: `~/.local/share/keysmith/` (`$KEYSMITH_DATA`) — pid, log, `usage.jsonl`.

## License

MIT — see [LICENSE](LICENSE).
