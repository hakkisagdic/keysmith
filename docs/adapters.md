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
| `explicitOnly` | `false` | answers only a request that names it: never an alias leg (refused by `keysmith alias`, skipped and reported when hand-edited in), never probed by `doctor --probe-models`. The `claude` profile ships it; `keysmith add <profile> --explicit-only` sets it on any other, a re-add keeps it, `keysmith set <id> explicitOnly false` drops it |
| `note` | — | shown in listings; the place to write down what you learned |
| `headers` | `{}` | extra request headers, HTTP only |

Every field of an attached adapter can be changed with
`keysmith set <adapter> <field> <value>` (JSON when it parses, a string otherwise; `--unset`
removes it), so a live config is never opened by hand. The changed entry is built the way the
gateway builds it before it is saved: a value that would keep the adapter from loading is
refused with the gateway's own error (`--force` saves it anyway). Credentials are not resolved
for that check. Adapter and alias names are looked up as the config's own entries, so
`constructor` or `toString` is no adapter. The running gateway keeps the config it started
with: `add`, `remove`, `set`, `alias` and `key` say so while one runs, with the restart command.

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
| `noSessionFlag` | `--no-session` | what `{noSession}` renders as when the run is not resumed. Claude Code and Qoder refuse `--no-session` and take `--no-session-persistence`; their profiles say so |
| `parser` | `raw` | one of `cmd-ndjson`, `opencode-ndjson`, `claude-stream-json`, `agy-stream-json`, `kiro-stream-json`, `warp-ndjson`, `raw` |
| `modelsFrom` | — | `{ "args": ["--list-models"], "drop": ["preview"] }` — run the binary, read stdout: one model per line, or JSON (an array, or one under `models`/`data`; the id is `model_id`, `id`, `slug`, `model` or `name`; `visibility: "hide"` entries are left out) |
| `promptVia` | `arg` | `"stdin"` pipes the prompt instead, for CLIs that choke on long argv |
| `cwd` | process cwd | the agent's workspace: an empty directory keysmith owns (`~/.local/share/keysmith/workspaces/<name>`), created 0700 on first spawn. Every built-in CLI profile sets one, and so does `keysmith add custom`; without it the agent runs in the gateway's own working directory (under launchd, keysmith's source tree). The child's `PWD` is set to it as well: spawn() would leave the gateway's, and opencode takes `PWD` as its project directory |
| `workspaceFiles` | — | `{ "relative/path": "content" }` — files keysmith keeps inside a configured `cwd` (0600), put back before a spawn whenever they drift. Needs `cwd`; a path that leaves it is refused at load. See [agy as a plain text model](#agy-as-a-plain-text-model) |
| `toolDenialRetry` | — | an instruction; when a run ends in a refused tool call and no text, the request runs once more with this text in front of the prompt, inside the same `timeoutMs` |
| `stopAtToolCall` | `false` | for a CLI run as a text model: once the answer has text, the first tool call ends the run — the process is stopped and anything it says after that call is not part of the reply. A tool call before any text is left alone. `"always"` stops a call before any text too, and fails that request: for a CLI that kept its tools, a call is never the way to an answer |
| `unsafeTools` | `false` | keysmith could not take this CLI's tools away: it can run commands and edit files. Implies `explicitOnly`; `keysmith set` refuses to serve it (`disabled false`), to take the mark off, or to change anything that shapes what it runs or how it is stopped (`stopAtToolCall`, `args`, `resumeArgs`, `bin`, `env`, `cwd`, `parser`, `modelsFrom`, …) without `--allow-unsafe-tools`; the gateway logs it at load when it is enabled. An `args`/`resumeArgs` with an auto-approve flag (`--auto`, `--yolo`, `--dangerously-skip-permissions`, `--full-auto`, `--trust-all-tools`, `--permission-mode yolo`, `--sandbox danger-full-access`, …) is a load error unless the entry has this mark. See [Warp](#warps-oz-an-agent-that-keeps-its-tools) and [Command Code](#command-code-an-agent-that-approves-its-own-tools) |
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
| `cmd-ndjson` | `{"type":"event","event":{"type":"text_delta",…}}` then one `{"type":"result",…}`; `tool_queued`/`tool_running` are one `tool` event per call | Command Code 1.66.0 (live); the tool events from the 1.81.0 bundle |
| `opencode-ndjson` | `text` parts re-send the **whole** block; the parser forwards only the new tail; `tool_use` is one `tool` event per `callID`; an `error` line's reason is `error.data.message` (with its `statusCode`) | opencode 1.18.27 |
| `claude-stream-json` | `assistant` message objects, then `result` with usage/session/`is_error` | Claude Code 2.1.261 |
| `agy-stream-json` | `step_update` text deltas on `agent_response` steps, then `result`; usage summed per step (the `result` total re-counts a resumed thread), an auto-denied tool call with no answer is an error with code `tool_denied`, each `tool` step is reported once as a `tool` event, and a run stopped before its `result` line still reports what its steps spent | Antigravity CLI 1.3.3 |
| `kiro-stream-json` | `{type,data}` lines: `metadata` carries the sessionId, `sessionUpdate` wraps the ACP update (`agent_message_chunk` text, `agent_thought_chunk` reasoning, `tool_call` reported once), `runFinished.finalText` answers when no chunk did, `runError.message` is an error | Kiro CLI 2.27.1 — runStarted/metadata/runError live; the text events from the binary and the ACP schema |
| `warp-ndjson` | `agent` lines are the text, `agent_reasoning` reasoning, `tool_call` a `tool` event, `system`/`conversation_started` the session; no usage, no closing line | Oz CLI v0.2026.10.07 (a live run) |
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

Gemini 4 Argon through agy: the effort is part of the model id
(`gemini-4-argon-low|medium|high`), and `high` is its maximum — agy refuses
`--effort max`/`xhigh` for it. The API route and its `reasoning_effort` are in the README,
under "Gemini 4 Argon at its highest effort".

### Kiro as a plain text model

`kiro-cli chat` is Kiro's coding agent. The `kiro` profile runs it the way `agy` runs:

- `--no-interactive` (headless) and `--output-format stream-json`;
- `--agent keysmith-text`, an agent file `workspaceFiles` writes to
  `.kiro/agents/keysmith-text.json` in the adapter's `cwd`, where Kiro finds workspace agents
  (`kiro-cli agent list` shows it as "Workspace", `kiro-cli agent validate` accepts it):
  `tools: []`, `allowedTools: []`, `mcpServers: {}` with `includeMcpJson: false`,
  `resources: []` (no steering files — yours in `~/.kiro/steering` would otherwise be part of
  the prompt) and `hooks: {}`. Kiro answers an agent name it cannot set with a warning and its
  default agent, so the file is put back whenever it drifts;
- `--trust-tools=`: an empty trust list, so any tool left would be refused, never run —
  `-a/--trust-all-tools` is the flag that must never be there;
- `--` before the prompt, and `stopAtToolCall` in case a call shows up after the answer.

Models come from `kiro-cli chat --list-models --format json` (`model_id`, `description`,
`context_window_tokens`), `auto` included. Every request is a fresh run (`--resume-id`
exists but resuming was not checked live), billed in Kiro credits.

What was seen live, on 2026-10-19 with kiro-cli 2.27.1: `runStarted`, three `metadata` lines
(sessionId, context use, reasoning support) and a `runError` — the account had reached its
overage limit, which the client receives as `kiro: … You have reached the limit for
overages.` The text events (`sessionUpdate` with an ACP `agent_message_chunk`, and
`runFinished.finalText`) are named in the binary but were not seen, so the parser reads the
answer from either. Check the first real answer before putting `kiro` in an alias. Kiro is
in `~/.local/bin`, which the LaunchAgent's PATH does not include: `keysmith add kiro --bin
~/.local/bin/kiro-cli`.

### Warp's oz: an agent that keeps its tools

`oz agent run --output-format ndjson --prompt …` (the `oz` inside Warp.app;
`/usr/local/bin/warp-cli` is Cloudflare WARP, a VPN client) answered a one-line prompt with
three lines — `system`/`run_started` (with a `run_url` on oz.warp.dev), `system`/
`conversation_started`, `agent` `{text}` — and no usage. `--no-snapshot` keeps it from
uploading a snapshot of the workspace at the end; models come from
`oz model list --output-format json`.

It cannot be made tool-less from here. `oz agent run` takes an agent profile by id
(`--profile`), but profiles are created in the Warp app, the default one lets the agent read
and write files and run commands, and a profile's permission values (`agent_decides`,
`always_ask`, `always_allow`) only ask or allow. So the profile is marked `unsafeTools`:
it ships `disabled: true`, is never an alias leg, is never probed, and `stopAtToolCall:
"always"` stops a run at its first `tool_call` line — before any text, that fails the
request. A command can already be running by then. Serve it only if you accept that:
`keysmith set warp disabled false --allow-unsafe-tools`.

### Command Code: an agent that approves its own tools

`cmd -p` keeps its tools and approves them itself. In Command Code 1.81.0's bundle a headless
run answers every tool confirmation with "allow" (`headlessInteraction({autoAllow: true})`;
only a call flagged as risky is denied), and `-p` withholds just the interactive tools —
ask_user_question, enter/exit plan mode, plan_review, todo_write, the cron tools, taste.
Shell, read, write and edit stay. `--max-turns 1` caps the turns that follow a call, not the
call, and nothing on its command line removes the tools (`--tools-all` / `--tools-enable` only
add). So the `cmd` profile is `unsafeTools`: it ships disabled, runs in its own workspace, and
`stopAtToolCall: "always"` stops a run at its first `tool_queued` event — emitted before the
permission check and `tool_running`, so usually before the call runs, but not guaranteed. A
`cmd` entry attached before this change has no mark and keeps serving until it is re-added or
`keysmith set cmd disabled true`.

### opencode as a plain text model

opencode's default `build` agent starts from `"*": "allow"` — bash, edit, write, read, glob,
grep, task, webfetch, todowrite and skill run without asking — and `--auto` only approves the
few rules left at "ask". The `opencode` profile drops `--auto` and takes the tools away twice,
with two files `workspaceFiles` keeps in its workspace:

- `.opencode/agent/keysmith-text.md`, a workspace agent with `permission: {"*": deny}` and
  `tools: {"*": false}`, selected by `--agent keysmith-text`;
- `opencode.json`, the project config: `permission: {"*": "deny"}`, `tools: {"*": false}`, no
  MCP servers, no plugins — for every agent, because opencode answers an `--agent` it cannot
  find with a warning and its default agent.

`--pure` loads no external plugin and `--` ends the options. Checked with opencode 1.18.27
against a stub OpenAI endpoint: the default agent was offered 10 tools, this one none (`tools:
[]`); a bash call the stub returned anyway failed as "unavailable tool" and created nothing;
an unknown agent name fell back to the default agent, which the project config left with no
tools either. `stopAtToolCall` ends the run at a tool call that comes after the answer.

opencode's free models (`opencode/*`, e.g. `opencode/big-pickle`) refused this run with
`403 OpenCode's free tier can only be used from within OpenCode` — and the default agent under
the deny-all config too; the same model answered only the default agent with its tools, which
keysmith does not run. A provider you configured in opencode with your own key is not subject
to that check (not run live from here).

### Claude Code, Qoder and Codex without tools

- `claude`: `--tools ""` (no built-in tool), `--strict-mcp-config` with no `--mcp-config`
  (no MCP server), `--permission-prompts none` (anything that would still ask is denied),
  `--disable-slash-commands`, `--safe-mode` (no CLAUDE.md, plugins, hooks or custom agents;
  auth and model selection stay), `--max-turns 1`. `{noSession}` is
  `--no-session-persistence`: 2.1.261 refuses `--no-session` as an unknown option. All of it
  parsed by 2.1.261 with an empty prompt, which it rejects before sending anything; no
  request went through it. It spends your Claude subscription, so the profile ships
  `explicitOnly: true`: no alias, no probe, and a re-add keeps it.
- `qoder`: `--tools ""` and `--strict-mcp-config`; `{noSession}` is
  `--no-session-persistence` (1.1.59 refuses `--no-session` too).
- `codex`: `--disable shell_tool` takes the shell away (`--disable unified_exec` is passed
  too, but 0.163 ignores it — `codex features list` still says true — and shell_tool is what
  removes exec), `--sandbox read-only` and `approval_policy="never"` cover anything left,
  `-c web_search="disabled"` removes the server-side web_search tool, `--disable goals` the
  goal tools, `--ignore-user-config` drops `~/.codex/config.toml` and the MCP servers it
  declares, `--ignore-rules`, and the `multi_agent`, `apps`, `plugins`, `browser_use`,
  `computer_use`, `image_generation`, `view_image` and `hooks` features are off;
  `--ephemeral` writes no session. Codex rejects an unknown feature name, so a renamed one
  fails loudly. What is left, read off a stub Responses endpoint with this argv on 0.163.0
  (scratch `CODEX_HOME`, `-c model_provider=…` pointing at the stub):
  - gpt-5.5: `request_user_input` (nobody answers it in exec) and `apply_patch`, which the
    read-only sandbox refuses ("writing is blocked by read-only sandbox");
  - gpt-6-*: code mode's `exec`/`wait` (JavaScript that can call only the listed tools — no
    shell), `request_user_input`, `clock.sleep`, and a `collaboration` namespace
    (`spawn_agent`, `send_message`, `wait_agent`, …) that `--disable multi_agent` and
    `multi_agent_v2` both leave in place. Sub-agents get the same tools; `-c
    agents.max_threads=1`, the lowest codex accepts, caps them at one besides the root (the
    prompt says 2 concurrency slots instead of 4). One request can still spend two agents'
    worth of quota.

  Models come from `codex debug models`. An npm codex and a Homebrew one can both be on PATH
  (the LaunchAgent's PATH finds the fnm/npm one first); pin the one you mean with `--bin`,
  e.g. `keysmith add codex --bin /opt/homebrew/bin/codex`.

`--tools` takes several values in both Claude Code and Qoder, so the profiles never put it
right before the prompt — it would take the prompt as a tool name.

## HTTP fields

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | required | `…/v1` or `…/v1/` both fine; a route suffix you pasted by accident is trimmed |
| `wire` | `openai` | `openai` → `POST {base}/chat/completions`; `anthropic` → `POST {base}/messages` with `x-api-key`. Set it explicitly — the other shape is not guessed from a hostname. |
| `apiKey` | — | a secret *reference*, see below; `false` for no auth (local servers) |
| `rawChat` behaviour | automatic | when a request carries `tools`, keysmith forwards the body verbatim to the first HTTP candidate and streams its answer unchanged, so real `tool_calls` survive. When every candidate refuses, the client gets the refusal with the provider's own status (and `retry-after`) — an earlier leg's 429/503 over a later leg's other refusal |
| `thoughtSignatures` | `false` | Gemini 3 (the `google` profile): remember `tool_calls[].extra_content.google.thought_signature` as answers pass through the tool relay, and put it back on a replayed call that lost it — the same call: same gateway key, id, function name and (parsed) arguments, told apart by the conversation before it when that is not enough; a call with no function name gets nothing. `true`, or `{ "maxEntries": 4096, "maxBytes": 16777216, "maxAgeMs": 21600000 }`; in memory, one store per upstream URL shared by every adapter on it (the largest limits win), never logged |
| `stripModelPrefix` | — | dropped from ids `/models` returns: `"models/"` for Google, whose listing says `models/gemini-3.8-flash` and whose requests take `gemini-3.8-flash` |
| `modelParams` | — | request fields sent with one upstream model: `{ "gemini-4-argon": { "reasoning_effort": "high" } }`, `"*"` for every model of the adapter. Under the fields keysmith builds (model, messages, stream… always win). On a plain completion keysmith builds the body, so this is what decides; on the tool relay the client's body goes verbatim and a field it set itself wins. A client that chose its effort in any spelling — `reasoning_effort`, `reasoning`, or Google's `thinking_config` under `extra_body.google` or `google` — gets no effort field from here at all (Google refuses `reasoning_effort` beside a thinking budget). A value that is not an object of fields is a load error, and `keysmith set` refuses it |

Upstream statuses: 401/403 stay auth errors, 429 and 503 keep their status (with
`retry-after` when the provider sent one) on the plain-completion path too; anything else
there is a 502. A streamed request holds its headers until its first event, for up to
`limits.streamHoldMs` (default 10000), so a refusal in that time keeps its status; one after
that is an SSE error frame on a 200. When failover moved on from a 429/503 and a later leg
refused for another reason, the 429/503 is what the client gets. A route with CLI legs does
not ask a leg that refused the tools again; its CLI legs answer without them. Google wraps
its errors in a one-element array; the message the client sees is `<adapter> <status>: <STATUS>: <provider message>`, e.g.
`google 429: RESOURCE_EXHAUSTED: You exceeded your current quota…`.

## Secret references

`apiKey` is resolved when the gateway loads and never written to a log or a response:

```
{env:OPENAI_API_KEY}
{file:~/.config/keys/copilot}
{json:~/.local/share/opencode/auth.json#evren.key}
{dotenv:~/project/.env#GOOGLE_API_KEY}
{exec:security find-generic-password -s copilot-api -w}
sk-live-…                      (a literal; works, discouraged)
```

`{json:…#dot.path}` is the interesting one: it reuses a credential an agent already
keeps in its own store, so the same key is not pasted into a second file.
`{dotenv:path#NAME}` does the same for a project's `.env`: one `NAME=value` line
(`export` allowed; unquoted with an inline ` #comment` dropped, `'single'` as written,
`"double"` with `\n \" \\` unescaped; the last assignment wins; a quoted value ends on its
line). Nothing is expanded or executed, and an error never quotes the file. `{exec:…}`
covers a Keychain entry or a secrets manager; it runs through a shell with a 10 s cap.

A resolved key is registered with the redactor (`src/redact.js`) the moment its adapter
loads, so it comes out of every log line, usage row, error body and page as
`AIza…39 fp:1a2b3c4d` — the same treatment as the gateway key.

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
3. **No tools.** An agent with tools will call them — behind a tunnel, for whoever holds a
   key. Find the CLI's own switch for an empty tool list (`--tools ""`, an agent file with
   `tools: []`, a deny-all permission config, a trust list with nothing in it), never pass an
   auto-approve flag (keysmith refuses to load one without the `unsafeTools` mark), keep `cwd`
   an empty directory keysmith owns (`keysmith add custom` sets one), and add a turn cap
   (`--max-turns 1`). Then check what the model is offered, not what the flags promise: point
   the CLI at a stub endpoint and read the request's `tools`. If the CLI has no such switch,
   mark the adapter `unsafeTools` and keep it disabled.
4. **What it costs.** Some harnesses inject a 10–20k-token system prompt and bill it.
   `keysmith usage --hours 1` after one call tells you the truth; put it in `note`.

Write what you learned into the profile's `note` and `provenance` fields — the next
person to run this against a new version of that CLI is probably you, in six months.
