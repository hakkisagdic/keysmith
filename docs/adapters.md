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
| `parser` | `raw` | one of `cmd-ndjson`, `opencode-ndjson`, `claude-stream-json`, `agy-stream-json`, `raw` |
| `modelsFrom` | — | `{ "args": ["--list-models"], "drop": ["preview"] }` — run the binary, read stdout |
| `promptVia` | `arg` | `"stdin"` pipes the prompt instead, for CLIs that choke on long argv |
| `cwd` | process cwd | some agents read project context from here; a configured one is created (0700) on first spawn |
| `workspaceFiles` | — | `{ "relative/path": "content" }` — files keysmith keeps inside a configured `cwd` (0600), put back before a spawn whenever they drift. Needs `cwd`; a path that leaves it is refused at load. See [agy as a plain text model](#agy-as-a-plain-text-model) |
| `toolDenialRetry` | — | an instruction; when a run ends in a refused tool call and no text, the request runs once more with this text in front of the prompt, inside the same `timeoutMs` |
| `stopAtToolCall` | `false` | for a CLI run as a text model: once the answer has text, the first tool call ends the run — the process is stopped and anything it says after that call is not part of the reply. A tool call before any text is left alone |
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
{ type: 'error', message, code? } // terminal for this adapter; an alias may move on
{ type: 'tool', name }         // the agent started a tool call; for the adapter only (`stopAtToolCall`), never forwarded
{ type: 'done', finishReason } // exactly one, always last
```

`code` names a failure the adapter can act on without reading the sentence. There is one:
`tool_denied`, a run that called a tool the harness refused and answered nothing — the
failure `toolDenialRetry` retries.

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
| `agy-stream-json` | `step_update` text deltas on `agent_response` steps, then `result`; usage summed per step (the `result` total re-counts a resumed thread), an auto-denied tool call with no answer is an error with code `tool_denied`, each `tool` step is reported once as a `tool` event, and a run stopped before its `result` line still reports what its steps spent | Antigravity CLI 1.3.3 |
| `raw` | stdout *is* the answer; no usage, no session | any `-p`-style CLI |

Usage is normalised across spellings (`inputTokens` / `input_tokens` / `prompt_tokens`,
`cache.read`, …). When an upstream reports only a total, keysmith keeps the total and
**invents no split** — the split is exactly what people use to reason about quota.

### agy as a plain text model

Out of the box `agy -p` is a coding agent: a ~20k-token harness prompt, every MCP server in
your Antigravity config booted, and tools that headless mode then refuses — a model that
reaches for `RunCommand` answers nothing. A client that sends text and wants text back
needs none of it, so the `agy` profile runs agy's own agent format with the tools removed:

- `--agent keysmith-text` in `args` and `resumeArgs`;
- `workspaceFiles` writes `.agents/agents/keysmith-text.md` into the adapter's `cwd`, where
  agy looks for project agents. Its frontmatter is what does the work: `tools: []`,
  `inheritMcp: false`, `inheritCustomizations: false` (your `GEMINI.md`, skills, rules) and
  `excludeDefaultComponents: true` (agy's built-in harness sections). The H1 section is the
  whole system prompt;
- the file is compared before every spawn and put back if it changed, because agy treats
  an agent name it cannot find as "use the default agent" and says nothing.

Measured through the gateway on agy 1.3.3, `gemini-3.8-flash-medium`, three one-line
prompts, same machine, minutes apart:

| | prompt tokens | time to first token |
|---|---|---|
| default agent | 20,157 (16,303 of them cached from the second call on) | 17.7 – 19.1 s |
| `keysmith-text` | 666 – 675 | 4.5 – 6.1 s |

A model with no tools has nothing to be refused, so the retry below should never fire with
this agent. It is there for the setups where it can: `toolDenialRetry` runs a request once
more, with a stricter instruction in front of the prompt, when the first run ends in a
refused tool call and no text. The client sees only the answer; the refused run's tokens
are added to the reported usage, the gateway log says `retried after tool_denied`, and the
usage log row carries `retries: 1`. A second refusal is returned as the error it is.

One tool survives `tools: []`: agy attaches `manage_task` (its background-task manager) to
every agent, and nothing in the agent format removes it. A model that has just written a
command sometimes calls it to "check on" that command, is told there is no task, and
answers a second time. The agent's prompt names the tool, and the profile sets
`stopAtToolCall`: once the answer has text, the first tool call ends the run. The process
is stopped, the client gets the first answer only, the gateway log says `answer ended at a
call to manage_task`, and the usage log row carries `cutAt: "manage_task"`. A call before
any text is left alone — there it can be how the model gets to its answer.

What `stopAtToolCall` does not end: a response that keeps writing past its answer in a
single step, with no tool call. One replayed multi-turn shell-agent request did that in 2
of 9 calls, writing on as if it were the rest of the transcript (`User: [exit] …`) until
agy's 280 s print timeout. The answer is still the first part of the text, but the client
waits for the timeout.

Two things to know:

- `keysmith add agy` copies the profile into your config. A config written before this
  agent existed keeps its old `args` — run `keysmith add agy` again to pick it up.
- For agy's full coding agent, drop `--agent keysmith-text` from `args` and `resumeArgs`
  and set `stopAtToolCall` to `false`. You get the harness prompt, the MCP start-up and the
  headless refusals back with it.

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
