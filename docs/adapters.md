# Adapter reference

An adapter is a config object. There is no plugin API, no registry, nothing to fork: the
built-in profiles in [`src/profiles.js`](../src/profiles.js) are the same shape as
anything you write by hand, which is how a CLI nobody has heard of becomes a five-line
edit.

Two kinds:

```jsonc
{ "kind": "cli",  "bin": "cmd", "args": [...], "parser": "cmd-ndjson" }
{ "kind": "http", "baseUrl": "https://…/v1", "wire": "openai", "apiKey": "{env:KEY}" }
```

`kind` may be omitted: `bin` present means CLI, `baseUrl` present means HTTP.

## Shared fields

| Field | Default | Meaning |
|---|---|---|
| `kind` | inferred | `cli` or `http` |
| `priority` | cli 200, http 100 | orders the flat `/v1/models` listing only. **It does not order an alias chain** — declared order wins there, because you wrote the chain. |
| `disabled` | `false` | keeps the entry, takes it out of service |
| `timeoutMs` | cli 300000, http 120000 | SIGTERM, then SIGKILL five seconds later; for HTTP it is `AbortSignal.timeout` |
| `models` | — | explicit catalogue: `["gpt-4.1","gpt-4o"]`, or `{"gpt-4o": {"contextWindow": 128000}}`. Also what an alias leg is checked against at startup — declare the subset you can actually run and a typo in a chain becomes a warning instead of a silent re-route. |
| `defaultModel` | — | used when the request has no model part (`"cmd"` alone) |
| `modelMap` | — | `{ "<requested>": "<upstream>" }` rewrite, HTTP only |
| `note` | — | shown in listings; the place to write down what you learned |
| `headers` | `{}` | extra request headers, HTTP only |

### Alias legs are checked against these fields, not against traffic

`keysmith doctor`, the status page, `GET /v1/models` (`keysmith.errors`) and
`GET /v1/keysmith/routes` (`alias_warnings`) all name any alias leg that cannot work:
a leg whose adapter is missing, failed to load, or disabled; an empty chain; an alias
referencing another alias; a leg naming a model that the adapter's `models` does not
contain. Requests still succeed when only part of a chain is broken — `resolve()` skips a
dead leg inside an alias rather than poisoning the route — the point of the check is that
failover otherwise answers your `chat` request from a provider you did not choose.

Legs pointing into a *dynamic* catalogue (a CLI with no `models`, whose list comes from
`modelsFrom`) are not checked at startup: that would mean spawning every adapter on the way
to a listening socket. `keysmith doctor --probe-models` spends the requests instead.

## CLI fields

| Field | Default | Meaning |
|---|---|---|
| `bin` | the adapter id | resolved through `PATH`, or an absolute/`~` path |
| `args` | `["{prompt}"]` | argv template, see below |
| `resumeArgs` | — | template used when a session id exists |
| `persistSessions` | `false` | the CLI keeps its own threads, so `{noSession}` renders empty and `resumeArgs` becomes reachable |
| `parser` | `raw` | one of `cmd-ndjson`, `opencode-ndjson`, `claude-stream-json`, `raw` |
| `modelsFrom` | — | `{ "args": ["--list-models"], "drop": ["preview"] }` — run the binary, read stdout |
| `promptVia` | `arg` | `"stdin"` pipes the prompt instead, for CLIs that choke on long argv |
| `cwd` | process cwd | some agents read project context from here |
| `env` | `{}` | merged over the scrubbed parent env |
| `maxConcurrent` | `1` | semaphore; each call is a real process |
| `stripSystemPrompt` | `false` | drop system turns instead of inlining them |
| `systemFlag` | — | e.g. `"--system-prompt"`: passed as `--system-prompt <text>` when a system turn exists |
| `maxPromptChars` | `200000` | refuses a request rather than handing a 400 KB argv to a subprocess |

### The argv template

```json
["-p", "{noSession}", ["--model", "{model}"], "{prompt}"]
```

- `{model}`, `{prompt}`, `{system}`, `{session}`, `{maxTokens}`, `{noSession}` are substituted.
- A **whole-token placeholder** keeps its value as one argv entry — a prompt with spaces
  and newlines is never word-split, and if it is empty the token disappears instead of
  leaving `""` on the command line.
- A **nested array is a group**: `["--model", "{model}"]` is dropped *whole* when the
  placeholder has no value. Without this, a model-less request leaves `--model` behind
  and the CLI eats your prompt as its argument.
- `{noSession}` is the adapter filling in `--no-session-persistence` (or the CLI's
  equivalent) only when it is *not* going to resume. One template covers both modes.

### What the prompt looks like

A CLI takes one string, so the message list is flattened: system turns hoisted (or
inlined as a `<system>…</system>` block when there is no dedicated flag), then

```
User: …

Assistant: …

User: …
```

Images are not dropped silently — they become `[image omitted by keysmith]`, because a
vision request that arrives as text must say so.

### Parsers, and the event contract

A parser is `async function*(lines)` yielding canonical events:

```js
{ type: 'delta', text }        // append to the answer
{ type: 'reasoning', text }    // thinking text — dropped unless the request asked for it
{ type: 'usage', usage }       // { input, output, cacheRead, cacheWrite } or { total }
{ type: 'session', id }        // resumable upstream conversation id
{ type: 'error', message }     // terminal for this adapter; an alias may move on
{ type: 'done', finishReason } // exactly one, always last
```

`reasoning` is gated by the gateway, not the parser: it only reaches a client that sent
`"include_reasoning": true` on `/v1/chat/completions`, where it arrives as
`delta.reasoning_content` (streaming) or `message.reasoning_content` (not). The other two
faces drop it — a thinking block the client did not ask for is a surprise, and on the
Anthropic face it is a block that needs a signature the CLI never gave us.

Two rules a parser must never break: never throw on a line you do not understand (an
unknown event is noise; killing a half-delivered answer over it is worse), and always
yield `done` (a stream with no terminator is a client that hangs forever).

| Parser | Shape | Verified against |
|---|---|---|
| `cmd-ndjson` | `{"type":"event","event":{"type":"text_delta",…}}` then one `{"type":"result",…}` | Command Code 1.66.0 |
| `opencode-ndjson` | `text` parts re-send the **whole** block; the parser forwards only the new tail | opencode 1.18.27 |
| `claude-stream-json` | `assistant` message objects, then `result` with usage/session/`is_error` | Claude Code 2.1.261 |
| `raw` | stdout *is* the answer; no usage, no session | any `-p`-style CLI |

Usage is normalised across spellings (`inputTokens` / `input_tokens` / `prompt_tokens`,
`cache.read`, …). When an upstream reports only a total, keysmith keeps the total and
**invents no split** — the split is exactly what people use to reason about quota.

## HTTP fields

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | required | `…/v1` or `…/v1/` both fine; a route suffix you pasted by accident is trimmed |
| `wire` | `openai` | `openai` → `POST {base}/chat/completions`; `anthropic` → `POST {base}/messages` with `x-api-key`. Set it explicitly — the other shape is not guessed from a hostname. |
| `apiKey` | — | a secret *reference*, see below; `false` for no auth (local servers) |
| `rawChat` behaviour | automatic | when a request carries `tools`, keysmith forwards the body verbatim to the first HTTP candidate and streams its answer unchanged, so real `tool_calls` survive |

## Secret references

`apiKey` is resolved when the gateway loads and never written to a log or a response:

```
{env:OPENAI_API_KEY}
{file:~/.config/keys/copilot}
{json:~/.local/share/opencode/auth.json#evren.key}
{exec:security find-generic-password -s copilot-api -w}
sk-live-…                      (a literal; works, discouraged)
```

`{json:…#dot.path}` is the interesting one: it reuses a credential an agent already
keeps in its own store, so the same key is not pasted into a second file. `{exec:…}`
covers a Keychain entry or a secrets manager; it runs through a shell with a 10 s cap.

A reference that resolves to nothing is a **load error, not a silent skip**: the adapter
stays out of service, `doctor` names the missing env var, `/v1/models` reports it,
`GET /v1/keysmith/routes` lists it under `failed_to_load`, the status page shows it, and
a request to that model answers 503 with the reason.

## Adding a CLI nobody ships a profile for

```bash
keysmith add custom --as myagent --bin myagent --args '["-p","{prompt}"]' --parser raw
keysmith doctor                                  # does it load, does it list models
keysmith chat myagent "<model id>" "say hi"      # one-shot, straight through the gateway
```

Then work out the four facts that matter, in this order:

1. **Non-interactive flag.** `-p`, `--print`, `run`, `exec`, `--no-input`. Without it you
   get a TTY escape sequence instead of an answer.
2. **A machine-readable stdout.** If the CLI has `--output-format json` / `--json`, pick
   the parser that fits; if it has none, use `raw` and accept that there are no token
   counts. Watch out for banners, spinners and ANSI codes going to stdout — they become
   the answer.
3. **A turn cap.** An uncapped agent will call tools and edit files in `cwd`. Pass
   `--max-turns 1` or its equivalent, or set `cwd` somewhere boring.
4. **What it costs.** Some harnesses inject a 10–20k-token system prompt and bill it.
   `keysmith usage --hours 1` after one call tells you the truth; put it in `note`.

Write what you learned into the profile's `note` and `provenance` fields — the next
person to run this against a new version of that CLI is probably you, in six months.
