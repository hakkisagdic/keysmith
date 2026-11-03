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
| `explicitOnly` | `false` | answers only a request that names it: never an alias leg (refused by `keysmith alias`, skipped and reported when hand-edited in), never probed by `doctor --probe-models`. The `claude` profile ships it; `keysmith add <profile> --explicit-only` sets it on any other, a re-add keeps it, `keysmith set <id> explicitOnly false` drops it. It does not keep any *key* away from the adapter: a key's scope does that (`keysmith key add <label> --deny <adapter>`, see the README's "Keys with a scope") |
| `note` | — | shown in listings; the place to write down what you learned |
| `headers` | `{}` | extra request headers, HTTP only |
| `media` | — | the kinds of media the adapter takes: any of `image`, `pdf`, `audio`, `video`. A request that carries one goes to it as the thing itself, any other kind as a label. A CLI and the `anthropic` wire take `image` and `pdf` only; anything else there is a load error. `keysmith set <id> media image,pdf` writes the list. See [Media](#media-images-pdfs-audio-video) |
| `vision` | `false` | `true` puts `image` among `media`. `false` beside a `media` that lists `image` is a load error; `keysmith vision <id> off` takes image out of both |
| `maxImages` | `20` | images one request may carry to this adapter; more is a 400 |
| `maxImageBytes` | `5242880` | the largest image, decoded, this adapter takes; larger is a 400 |
| `maxFiles` | `5` | PDFs, audio and video files one request may carry to this adapter; more is a 400 |
| `maxFileBytes` | `20971520` | the largest PDF, audio or video file, decoded, this adapter takes; larger is a 400 |

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

## Media: images, PDFs, audio, video

An adapter takes the kinds its `media` lists — `image`, `pdf`, `audio`, `video`; `vision: true`
is `image`. A request that carries one of those reaches it as the thing itself. Any other kind,
and every item on an adapter with no `media`, reads as a label in its place: `[image omitted by
keysmith]`, `[PDF omitted by keysmith]`, `[audio omitted by keysmith]`, `[video omitted by
keysmith]`, and `[file omitted by keysmith]` for a file whose part says nothing of its kind. A
model handed the text knows something was there.

What each face takes:

| Face | Image | PDF | Audio | Video |
|---|---|---|---|---|
| `/v1/chat/completions` | `image_url` (its `detail` kept) | `file` (`file_data`) | `input_audio` | `video_url` (vLLM's and OpenRouter's shape) |
| `/v1/messages` | `image`, a `base64` or `url` source | `document`, a `base64` or `url` source | — | — |
| `/v1/responses` | `input_image` | `input_file` (`file_data` or `file_url`) | `input_audio` | — |

The kind and type are read off the bytes, not the part: JPEG, PNG, GIF, WebP; PDF; WAV, MP3,
AAC, FLAC, Ogg, M4A; MP4, QuickTime, WebM. A declared type that disagrees is corrected, a PDF
sent as an `image_url` is a PDF, and anything else is a 400. A file with neither a type nor a
name is read to learn what it is. An uploaded-file reference (`file_id`, a `file` source) is
refused: keysmith keeps no files. A `document` whose source is text is no media, and reads as it
always has.

**Where it goes.**

- **An HTTP upstream** gets each user turn that carries media as a content array — its text and
  its media in their order — in its own wire. On `openai`: `image_url` (a data: URL),
  `input_audio` (`data`, and the `format` the bytes have: `wav`, `mp3`, `aac`, `flac`, `ogg` or
  `m4a`), `file` for a PDF (`filename`, `file_data` as a data: URL), `video_url` (a data: URL).
  On `anthropic`: base64 `image` and `document` blocks, a PDF's file name as its `title`. Media
  goes up in a user turn only — neither API takes it in a system or assistant turn, where it
  stays the label — and a turn whose media all became labels goes up as text. `mediaHeaders` go
  with a request that carries media up, and with no other.
- **A CLI** runs `visionArgs` instead of `args`: the prompt is flattened exactly as for any
  other run, and goes to the CLI's stdin as one Claude Code stream-json user message, the text
  cut where each item was and the items between as base64 `image` / `document` blocks:

  ```json
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"User: Transcribe:\n"},{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"/9j/4AAQ…"}},{"type":"text","text":"\nthe first page"}]}}
  ```

  So `visionArgs` has no `{prompt}`, and takes stdin as stream-json (`--input-format
  stream-json` for Claude Code); the rest of it is the text run's tool-less argv. A request
  whose media the CLI takes none of runs `args`, its items as labels. No temporary file is
  written, and a media run is never resumed.
- **The tool relay** — a request with `tools` to an HTTP upstream on the openai wire — is
  verbatim, as before: what the client sent goes up unread, URLs and all.

**URLs.** A URL (`http` or `https`) is fetched by keysmith and sent inline, to an upstream and a
CLI alike — only from the public internet. The gateway can sit behind a tunnel, and a fetch on a
key holder's behalf must not reach this machine, its network or a cloud's metadata service: an
address in a loopback, private (10/8, 172.16/12, 192.168/16), shared (100.64/10), link-local
(169.254/16, fe80::/10), unique-local (fc00::/7), documentation, multicast or reserved range is
refused, written as an address or reached by name — every address a name resolves to is
checked, and the connection goes to the address that was checked, so a name that resolves anew
in between (DNS rebinding) changes nothing. A redirect is followed, at most 3, each checked as
the first; the whole fetch has 20 seconds; the size cap is counted as the bytes arrive; nothing
of the client's goes along (no key, no cookie, no credentials from the URL). A URL is fetched
once per request: every leg of a route reads the same bytes. A failure is a 400 that names the
URL's host and never its path or query (which may be a signed token). `"fetchMedia": false` at
the top of the config refuses every URL instead.

**Limits.** Per adapter: `maxImages` (20) and `maxImageBytes` (5 MB decoded) for images;
`maxFiles` (5) and `maxFileBytes` (20 MB decoded) for PDFs, audio and video. Every item is read
before anything is sent or started, so a bad one is a 400 that costs nothing — no upstream
request, no process. An error never quotes media data. `GET /v1/keysmith/routes` says what each
adapter takes (`media`, and `vision` for images).

**What is known to work.**

- The `claude` profile takes `image` and `pdf`. Claude Code 2.1.303 sent an image block and a
  `document` block from such a stdin message on to a stub Messages endpoint as they were; live,
  on sonnet, a scanned typewritten Greek page sent through `/v1/chat/completions` and
  `/v1/messages` came back transcribed. agy 1.4.12 takes stream-json on stdin too, and refuses an
  image block in it (`only "text"`), so the `agy` profile has none.
- The HTTP profiles: `openai` takes `image`, `pdf` and `audio` (audio reaches only OpenAI's audio
  models; another answers with its own error), `anthropic` `image` and `pdf`, `google` `image`
  and `audio`, `copilot` `image`, with `copilot-vision-request: true` (not checked live). Gemini's
  OpenAI-compatible endpoint, live on 2026-11-03: an image (`image_url`, a data: URL) through
  keysmith came back read on `gemini-3.5-flash`; a PDF as a `file` part and a video as a
  `video_url` part were refused, 400 `Invalid content part type`, so the profile takes neither.
  Audio (`input_audio`) is on Google's page and was not run. The others take none: what a local server or OpenRouter sees
  depends on the model it runs — `keysmith set <id> media image` when yours does.
- An entry attached before this has no `media`: `keysmith upgrade <id> --apply` brings its
  profile's (or `keysmith vision <id> on`, for images).

## CLI fields

| Field | Default | Meaning |
|---|---|---|
| `bin` | the adapter id | resolved through `PATH`, or an absolute/`~` path |
| `args` | `["{prompt}"]` | argv template, see below |
| `resumeArgs` | — | template used when a session id exists |
| `persistSessions` | `false` | the CLI keeps its own threads, so `{noSession}` renders empty and `resumeArgs` becomes reachable |
| `noSessionFlag` | `--no-session` | what `{noSession}` renders as when the run is not resumed. Claude Code and Qoder refuse `--no-session` and take `--no-session-persistence`; their profiles say so |
| `parser` | `raw` | one of `cmd-ndjson`, `opencode-ndjson`, `claude-stream-json`, `agy-stream-json`, `kiro-stream-json`, `warp-ndjson`, `codex-json`, `codex-json-final`, `raw` |
| `modelsFrom` | — | `{ "args": ["--list-models"], "drop": ["preview"], "stdin": "…" }` — run the binary (`stdin` written to it when set), read stdout: one model per line, or JSON (an array, or one under `models`/`data`; the id is `model_id`, `id`, `slug`, `model`, `value` or `name`; `visibility: "hide"` entries are left out), or a stream-json `control_response` (Claude Code's answer to `initialize`). The effort levels a model takes are read from it too: Codex's `supported_reasoning_levels`, Claude Code's `supportedEffortLevels` |
| `promptVia` | `arg` | `"stdin"` pipes the prompt instead, for CLIs that choke on long argv. A command line cannot carry a NUL character (U+0000): a request with one in its argv (the prompt, a system prompt) is a 400 that quotes none of it, before anything is started — the route goes on to its next leg, which an HTTP upstream can take |
| `cwd` | process cwd | the agent's workspace: an empty directory keysmith owns (`~/.local/share/keysmith/workspaces/<name>`), created 0700 on first spawn. Every built-in CLI profile sets one, and so does `keysmith add custom`; without it the agent runs in the gateway's own working directory (under launchd, keysmith's source tree). The child's `PWD` is set to it as well: spawn() would leave the gateway's, and opencode takes `PWD` as its project directory |
| `workspaceFiles` | — | `{ "relative/path": "content" }` — files keysmith keeps inside a configured `cwd` (0600), put back before a spawn whenever they drift. Needs `cwd`; a path that leaves it is refused at load. See [agy as a plain text model](#agy-as-a-plain-text-model) |
| `toolDenialRetry` | — | an instruction; when a run ends in a refused tool call and no text, the request runs once more with this text in front of the prompt, inside the same `timeoutMs` |
| `stopAtToolCall` | `false` | for a CLI run as a text model: once the answer has text, the first tool call ends the run — the process is stopped and anything it says after that call is not part of the reply. A tool call before any text is left alone. `"always"` stops a call before any text too, and fails that request: for a CLI that kept its tools, a call is never the way to an answer |
| `toolMode` | `off` | how this CLI answers a request that offers tools: `off` (it is passed by, as before toolMode existed), `emulate` (EMULATE: the model writes its calls as JSON, keysmith hands them to the client — see [agy and tool requests: EMULATE](#agy-and-tool-requests-emulate)), `mcp` (the MCP bridge: the CLI calls the request's tools over MCP and waits while the client runs each one — see [agy and tool requests: the MCP bridge](#agy-and-tool-requests-the-mcp-bridge); agy, opencode, codex and qoder have a bridge driver) or `auto` (the bridge where it can, EMULATE otherwise and when the bridge fails before any call). The `agy`, `opencode`, `codex` and `qoder` profiles ship `auto` (see [opencode, codex, qoder and kiro](#opencode-codex-qoder-and-kiro-tool-requests)); `claude` and `kiro` say `off`. A load error on an `unsafeTools` entry, on an entry without a `cwd` (a tool engine runs the CLI only in an empty workspace keysmith owns, never the gateway's own directory; every built-in profile has one) and on an HTTP adapter. `keysmith set <id> toolMode <mode>` fills in the templates below from the entry's built-in profile when it lacks them |
| `emulateArgs` | `args` | the argv template of an EMULATE run, same placeholders as `args`; no session is resumed on that path, so `{session}` is always empty. agy's names the `keysmith-tools` agent |
| `bridge` | — | the MCP bridge's settings: `driver` (`agy`, `opencode`, `codex`, `qoder` or `claude`; absent, agy's for an `agy-stream-json` entry), `args`, its argv template, with `{agent}` (the session's agent), `{server}`, `{printTimeout}` (its `sessionMaxMs`, as `1800s`) and the driver's own placeholders (see [opencode, codex, qoder and kiro](#opencode-codex-qoder-and-kiro-tool-requests)) filled in per session — read by the auto-approve check below, and an approval in it may approve the session's own server only; `maxSessions` (2), `toolResultTimeoutMs` (300000), `readyTimeoutMs` (30000), `sessionMaxMs` (1800000), `maxTurns` (32); `mcpCacheDir` (`~/.gemini/antigravity-cli/mcp`, where agy keeps a server's schemas). See [agy and tool requests: the MCP bridge](#agy-and-tool-requests-the-mcp-bridge) |
| `unsafeTools` | `false` | keysmith could not take this CLI's tools away: it can run commands and edit files. Implies `explicitOnly`; `keysmith set` refuses to serve it (`disabled false`), to take the mark off, or to change anything that shapes what it runs or how it is stopped (`stopAtToolCall`, `args`, `resumeArgs`, `visionArgs`, `bin`, `env`, `cwd`, `parser`, `modelsFrom`, …) without `--allow-unsafe-tools`; the gateway logs it at load when it is enabled. An argv template — `args`, `resumeArgs`, `emulateArgs`, `visionArgs`, `bridge.args` — with an auto-approve flag (`--auto`, `--yolo`, `--dangerously-skip-permissions`, `--full-auto`, `--trust-all-tools`, `--permission-mode yolo`, `--sandbox danger-full-access`, agy's `--mode auto` / `--mode accept-edits`, …) is a load error unless the entry has this mark; with it, `toolMode` must be `off` (`keysmith set <id> unsafeTools true`, and a re-add that keeps the mark, turn it off). See [Warp](#warps-oz-an-agent-that-keeps-its-tools) and [Command Code](#command-code-an-agent-that-approves-its-own-tools) |
| `env` | `{}` | merged over the scrubbed parent env |
| `maxConcurrent` | `1` | semaphore; each call is a real process |
| `stripSystemPrompt` | `false` | drop system turns instead of inlining them |
| `systemFlag` | — | e.g. `"--system-prompt"`: passed as `--system-prompt <text>` when a system turn exists |
| `maxPromptChars` | `200000` | refuses a request rather than handing a 400 KB argv to a subprocess |
| `visionArgs` | — | the argv template of a run that carries media, which a CLI with `media` (or `vision`) needs: its prompt goes on stdin as one stream-json user message with the media in it, so it has no `{prompt}`, and `{session}` is always empty. Read by the auto-approve check like every other template. `keysmith set <id> vision true` (or `media …`, or `keysmith vision <id> on`) fills it in from the entry's built-in profile when it lacks one, and `keysmith upgrade <id>` brings it |

### The argv template

```json
["-p", "{noSession}", ["--model", "{model}"], "{prompt}"]
```

- `{model}`, `{prompt}`, `{system}`, `{session}`, `{maxTokens}`, `{noSession}`, `{effort}` are substituted.
- A **whole-token placeholder** keeps its value as one argv entry — a prompt with spaces
  and newlines is never word-split, and if it is empty the token disappears instead of
  leaving `""` on the command line.
- A **nested array is a group**: `["--model", "{model}"]` is dropped *whole* when the
  placeholder has no value. Without this, a model-less request leaves `--model` behind
  and the CLI eats your prompt as its argument. A placeholder inside a token counts too:
  `["-c", "model_reasoning_effort=\"{effort}\""]` goes whole when there is no effort.
- `{effort}` is the reasoning effort a request chose, checked against the CLI's catalogue
  (see [Reasoning effort](#reasoning-effort-on-a-cli)). An adapter takes one only when every argv
  template it has carries `{effort}`: one with it in none, or in some and not all (an entry
  upgraded in part), is handed no effort, as before, and the usage row's `effortIgnored` says so
  — naming, for the second, the templates to `keysmith upgrade <id> --take`.
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

Media is not dropped silently. A CLI that cannot take an item reads it as a label naming its
kind — `[image omitted by keysmith]`, `[PDF omitted by keysmith]`, `[audio omitted by
keysmith]`, `[video omitted by keysmith]` — because a request that arrives as text must say
what it lost. One that can (`media`; the `claude` profile takes images and PDFs) runs
`visionArgs`, its prompt on stdin with the media in it: see
[Media](#media-images-pdfs-audio-video).

### Parsers, and the event contract

A parser is `async function*(lines)` yielding canonical events:

```js
{ type: 'delta', text }        // append to the answer
{ type: 'reasoning', text }    // thinking text — dropped unless the request asked for it
{ type: 'usage', usage, scope? } // { input, output, cacheRead, cacheWrite, reasoning? } or { total }; scope 'run': the run's whole spend
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
| `opencode-ndjson` | a `text` line is one text part, **whole** (1.19.3 prints it once, when the part ends); the parser forwards per part id: a new part whole (two with no call between them are two paragraphs), a part printed again only for what it grew; `tool_use` is one `tool` event per `callID`; an `error` line's reason is `error.data.message` (with its `statusCode`) | opencode 1.18.27; the text lines from the 1.19.3 bundle |
| `claude-stream-json` | `assistant` message objects (each text block forwarded whole, a block sent again only for what it grew), then `result` with usage/session/`is_error`; a `tool_use` block is one `tool` event per id (qoder's lazy `mcp_call` as the tool it names). The `result` usage is the run's (`scope: 'run'`); on the MCP bridge each assistant message's own usage is reported too, once per message id | Claude Code 2.1.261, 2.1.303 (the usage lines, against a stub Messages endpoint); qodercli 1.1.59 (`-o stream-json`, live) |
| `codex-json` | `codex exec --json`: `agent_message` items are text (two with no call between them are two paragraphs), `reasoning` items reasoning, an `mcp_tool_call` a `tool` event named `mcp__<server>__<tool>` as it starts, any other item that acts (`command_execution`, `file_change`, `web_search`, a type never seen) a `tool` event named by its type; `turn.completed` the run's usage (`cached_input_tokens` and `reasoning_output_tokens` with it), `turn.failed` the error. The MCP bridge's codex parser | codex 0.163.0 (live) |
| `codex-json-final` | `codex exec --json` read as a text run: the last agent message only (what plain `codex exec` prints on stdout; a preamble message before it is left out), and `turn.completed`'s usage, which plain stdout does not carry. The `codex` profile's text and EMULATE parser (a codex entry attached before it, parser `raw`, reports no counts: `keysmith upgrade codex --take args,emulateArgs,parser,bridge --apply`) | codex 0.163.0 (live, 2026-11-03, gpt-6-astra) |
| `agy-stream-json` | `step_update` text deltas on `agent_response` steps, then `result`; usage summed per step (the `result` total re-counts a resumed thread), an auto-denied tool call with no answer is an error with code `tool_denied`, each `tool` step is reported once as a `tool` event, and a run stopped before its `result` line still reports what its steps spent | Antigravity CLI 1.3.3 |
| `kiro-stream-json` | `{type,data}` lines: `metadata` carries the sessionId, `sessionUpdate` wraps the ACP update (`agent_message_chunk` text, `agent_thought_chunk` reasoning, `tool_call` reported once), `runFinished.finalText` answers when no chunk did, `runError.message` is an error | Kiro CLI 2.27.1 — runStarted/metadata/runError live; the text events from the binary and the ACP schema |
| `warp-ndjson` | `agent` lines are the text, `agent_reasoning` reasoning, `tool_call` a `tool` event, `system`/`conversation_started` the session; no usage, no closing line | Oz CLI v0.2026.10.07 (a live run) |
| `raw` | stdout *is* the answer; no usage, no session | any `-p`-style CLI |

Usage is normalised across spellings (`inputTokens` / `input_tokens` / `prompt_tokens`,
`cache.read`, …), and read one way: `input` is every input token the upstream charged, the
ones it read from or wrote to its cache included — which is where a harness's own system
prompt usually sits — and `cacheRead` / `cacheWrite` say how many of them; `reasoning`, when
the CLI says, how many of `output` were thinking. A harness that counts the uncached input
alone (Anthropic's `input_tokens` in Claude Code's stream and on the Anthropic wire,
opencode's `tokens.input`) has the cache's counts added back by its parser. The faces write
it back in each API's own reading: `prompt_tokens` / `input_tokens` with
`cached_tokens` on the OpenAI faces, and on `/v1/messages` the uncached `input_tokens` with
`cache_read_input_tokens` and `cache_creation_input_tokens` beside it.

When an upstream reports only a total, keysmith keeps the total and **invents no split** —
the split is exactly what people use to reason about quota. When a CLI run reports nothing at
all (`raw`, `warp-ndjson`, a run stopped before its usage line), the answer says so: its
usage is null counts with a `reason`, on every face, and the usage row is `usage: null`
with a `usageReason` — never a 0, which reads as a free request.

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

### agy and tool requests: the MCP bridge

A client that offers tools wants calls back, not text. With `toolMode: "auto"` (the profile's)
or `"mcp"`, agy gets them over MCP: each request is a session agent whose one MCP server is
keysmith, offering the request's tools and nothing else. The model calls one; keysmith checks
the call against the client's schema and hands it to the client as a tool call, and agy waits on
it, in the same process, until the client's next request brings the result. The README's
"Tool calls" has the rules a client sees (which request continues which session, the cold path,
the 409, the clock, the room); this is what keysmith gives agy.

```bash
keysmith add agy                   # toolMode auto, emulateArgs, bridge, both agent files
keysmith set agy toolMode auto     # an entry attached before toolMode: adds what it lacks
keysmith set agy toolMode emulate  # EMULATE only: no MCP, no session held between requests
```

- The agent, `.agents/agents/ks-b-<rid>.md` in the adapter's `cwd`, written 0600 for the session
  and removed with it: `tools: []`, `inheritMcp: false`, `inheritCustomizations: false`,
  `excludeDefaultComponents: true`, no hooks, and `mcpServers` — a list (agy 1.4.2 does not read
  a map) of one server named `ks<rid6>`, new per session (agy caches a server's schemas under
  `mcpCacheDir/<server>/` whatever agent named it), whose command is the gateway's own node
  running `src/bridge/shim.js` (absolute paths: launchd's PATH does not matter), with the socket
  and the session's token in its `env`, and each of the request's tools marked `eager: true`.
- The argv is `bridge.args`: `--agent {agent}`, `--print-timeout {printTimeout}`, no
  `--conversation` (a lost session is never resumed, it is answered on the cold path) and no
  `--mode auto|accept-edits`, which would run agy's own tools unasked. agy runs in a process
  group of its own, so stopping a session stops the shim with it.
- The model sees a tool as `mcp_ks<rid6>_<name>`; Gemini takes 64 characters, so a tool name
  longer than 51 is EMULATE's (`fallback: "name_too_long"`). The call reaches keysmith with the
  tool's own name; the `toolSummary` agy shows its model next to a tool's parameters is taken off
  the arguments unless the client's schema has one.
- agy's stream is read per step (`agy-stream-json` with per-step usage): a turn's usage row
  counts the steps it ran. A call in it to anything but the bridge's tools and `manage_task` is
  the tripwire, wherever the session is — answering a request, or waiting while the client runs
  a call: agy is stopped then and there, the gateway log says `SECURITY … foreign tool`, and the
  usage row `failure: "foreign_tool"`. The request it was answering is a 502 that no other
  engine or leg of the route answers in its place — not EMULATE, not an HTTP upstream; a call
  that was with the client goes nowhere: the request that brings its result is the same 502
  (for that key, for the hour the call's tombstone lives).
  `manage_task` after an answer ends the run, as on the text path (`stopAtToolCall`, `cutAt`).
  `toolDenialRetry` does not run on the bridge.

```json
{
  "agy": {
    "kind": "cli",
    "bin": "agy",
    "parser": "agy-stream-json",
    "cwd": "~/.local/share/keysmith/workspaces/agy",
    "toolMode": "auto",
    "bridge": {
      "args": ["--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "{printTimeout}", "--agent", "{agent}", ["--model", "{model}"], "-p", "{prompt}"],
      "maxSessions": 2,
      "readyTimeoutMs": 30000,
      "toolResultTimeoutMs": 300000,
      "sessionMaxMs": 1800000,
      "maxTurns": 32
    }
  }
}
```

The gateway-wide limits are `limits.bridge`: `maxSessions` (2 sessions in all: a waiting agy
session is about 1 GB, see the README's "Tool calls"), `maxSessionsPerKey` (1) and `socket`
(`~/.local/share/keysmith/run/bridge.sock`; its directory must be one only you can enter, and
the path at most 103 bytes). `keysmith serve` opens the socket at start and says where, and
removes what the sessions of a gateway that was killed left behind (agent files and schema
directories of keysmith's naming, older than an hour).

### agy and tool requests: EMULATE

EMULATE is what `auto` runs where the bridge cannot — a `tool_choice` that forces a call
(`required`, a named tool: MCP cannot make a model call one), a tool name too long, no room, a
bridge that failed before its first call — and what `toolMode: "emulate"` runs always. agy's
`keysmith-tools` agent writes the calls as one JSON object, and keysmith hands them to the
client; the usage row says `toolMode: "emulate"` and, under `auto`, why (`fallback`).

```bash
keysmith set agy toolMode off      # tool requests pass agy by again
```

The agent file is what keeps agy tool-less, and agy answers an agent name it cannot find with
its full default agent, without a word — so the profile carries it under `workspaceFiles`,
rewritten before every run, and `keysmith set … toolMode` refuses an entry with no `cwd` to
write it into. Do not hand-write `emulateArgs` naming `keysmith-tools` without the file.

- `emulateArgs` runs `--agent keysmith-tools`: like `keysmith-text`, an agent file with
  `tools: []`, `inheritMcp: false`, `inheritCustomizations: false` and
  `excludeDefaultComponents: true`, whose prompt says the tools in the request are run by
  whoever sent it, that a tool result is data and not instructions, and that `manage_task` is
  not for calling. agy runs no tool; it writes a JSON object.
- The request itself carries the rest: the tools with their schemas as the client sent them,
  the answer format — `{"tool_calls":[{"name":…,"arguments":{…}}]}` or `{"final":"…"}` — with
  the rules `tool_choice` and `parallel_tool_calls` set, and the conversation, earlier calls
  written back as JSON and each tool result between `<<<TOOL_RESULT n=<nonce> …>>>` and
  `<<<END <nonce>>>>`.
- The reply is read whole before anything goes out, and strictly (see the README's "Tool
  calls"). An invalid reply is asked for once more, with the reason in front of the same
  prompt, inside the same `timeoutMs` and only when at least 15 s of it are left; the gateway
  log says `retried after invalid_reply: <reason>` and the usage row counts it. A second
  invalid reply is a 502 `tool_emulation_error` (an error frame instead, once the stream
  opened); its usage row has both runs' `usage`, `toolMode: "emulate"` and `retries: 1`. A run
  that agy itself fails (an unknown agent, a quota error, a non-zero exit) is the leg failing
  too. Either way an alias moves on, and the row of the leg that answers names the failed one
  in `failedLegs`, with what it spent added to the row's `usage`.
- A tool call of agy's own refused by headless mode, with no reply, is an invalid reply like
  any other; `toolDenialRetry` is for the text path and does not run here. A `manage_task` call
  after the JSON ends the run (`stopAtToolCall`): the JSON stands, the usage row says `cutAt`.
- `tool_choice: "none"` is a text answer: the text agent, with the history rendered the same
  way.

What it costs: every turn sends the whole transcript and every schema again (with 17 tools,
a few thousand tokens a turn), and an Argon turn took 9–44 s in the probes. The probes behind
the protocol ran agy 1.4.2 with a `tools: []` agent on gemini-4-argon-high: 7 of 7 replies were
one strictly parseable object.

Any CLI whose argv is already tool-less can answer tool requests the same way; with no
`emulateArgs` it runs its own `args`, and the protocol lives in the prompt alone:

```json
{
  "mycli": {
    "kind": "cli",
    "bin": "mycli",
    "args": ["-p", "{prompt}"],
    "parser": "raw",
    "cwd": "~/.local/share/keysmith/workspaces/mycli",
    "toolMode": "emulate"
  }
}
```

### opencode, codex, qoder and kiro: tool requests

The `opencode`, `codex` and `qoder` profiles answer a request that offers tools the way agy
does (`toolMode: "auto"`): through the MCP bridge, and through EMULATE where the bridge cannot.
Both ran a two-turn round trip live on each of them (2026-10-20) — a call that fit the schema,
then an answer that quoted the injected result:

| | EMULATE (turn 1 + turn 2) | the bridge (turn 1 + turn 2) | a waiting session |
|---|---|---|---|
| opencode 1.19.3, `evren/deepseek-v4-flash` | 4.7 s + 3.0 s | 4.9 s + 0.4 s | ~690 MB |
| codex 0.163.0, `gpt-5.6-luna` | 5.2 s + 3.2 s | 5.5 s + 1.8 s | ~110 MB |
| qodercli 1.1.59, its default model | 11.8 s + 12.1 s | 5.8 s + 4.2 s | ~370 MB |
| Claude Code 2.1.303, `haiku` at effort low (2026-11-03) | — | 6.1 s + 3.5 s (chat), 3.5 s + 3.2 s (messages, streamed), 3.2 s + 2.5 s (responses, streamed) | ~230 MB |

**EMULATE.** `emulateArgs` is each profile's text argv, as tool-less as it is for text —
opencode's `keysmith-text` agent and deny-all `opencode.json`, codex's read-only, shell-less
`exec`, qoder's `--tools "" --strict-mcp-config` — and the request's own prompt carries the tools
and the JSON answer format. Each reply is read by the profile's own parser (`opencode-ndjson`,
`raw`); qoder's other shape, `-o stream-json` with `claude-stream-json`, is read the same way. A
call the CLI's own harness reports before the reply (opencode's `tool_use`, kiro's ACP
`tool_call`: refused, since the agent has no tools) is passed by; one after the reply ends the
run there (`stopAtToolCall`), and the reply stands. codex adds its own ~20k-token harness to
every request, which its counts include (`codex-json-final`: `exec --json`'s turn.completed);
`raw` reports no token counts for qoder (null, with the reason).

**The bridge.** `bridge.driver` names how the session's one MCP server is given to the CLI, and
`bridge.args` is the argv, with these placeholders filled in per session besides `{model}` and
`{prompt}`: `{server}` (`ks<rid6>`), `{agent}` (`ks-b-<rid>`), and for codex `{mcpCommand}`,
`{mcpArgs}`, `{mcpEnv}` (TOML values: the gateway's node, the shim, the socket and the token
file), `{toolTimeoutSec}` and `{readyTimeoutSec}`; for qoder and claude `{mcpConfig}` (the
session's MCP config file). The session's files are in `.keysmith-bridge/` in the workspace
(0700, each file 0600) and go with the session.

- **opencode** (`opencode-ndjson`): `OPENCODE_CONFIG` names `ks-b-<rid>.json` — `mcp.<server>`
  (`type: local`, the shim, `timeout` 30 s past `toolResultTimeoutMs`: opencode's own 60 s gave
  up on a 75 s wait in the probe) and the inline agent `--agent {agent}`, whose permission and
  tools deny `"*"` and allow `<server>_*`. opencode merges the workspace's `opencode.json`
  (deny-all) over it — `opencode debug config` showed both, and `debug agent` every built-in
  tool off. `--pure` loads no plugin. The model sees `ks<rid6>_<tool>`. opencode runs a step's
  calls at once and reports each only when it finished, so the calls that come within 600 ms of
  each other go out in one answer; its `invalid` tool (its answer to a call of a tool it does not
  have) runs nothing and is not the tripwire's.
- **codex** (`codex-json`, `exec --json`): the profile's tool-less switches, and `-c
  mcp_servers.{server}.…` — the shim as command, `env` with the socket and
  `KEYSMITH_BRIDGE_TOKEN_FILE` (the token is in `ks-b-<rid>.token`, never in the argv),
  `default_tools_approval_mode="approve"` (with `approval_policy="never"`, codex refuses an MCP
  call that is not approved, before it reaches the server), `startup_timeout_sec` and
  `tool_timeout_sec` (codex's default, 60 s, is too short for a client running a tool).
  `--ephemeral` writes no session. The model sees `mcp__ks<rid6>__<tool>`. codex runs a step's
  calls one after the other and shows each (`item.started`) before it sends it. Any item that is
  not text, reasoning, its plan (`todo_list`) or a warning is a tool of codex's own, so the
  tripwire's: a shell command, a file change, a web search, a sub-agent, a type keysmith has never
  seen. A load check refuses an approval in `bridge.args` for anything but `mcp_servers.{server}`,
  and an `approval_policy` other than `"never"`. codex starts its MCP server outside its own
  process group; the shim ends when the session's connection closes all the same (checked live).
- **qoder** (`claude-stream-json`, `-o stream-json`): `--mcp-config {mcpConfig}
  --strict-mcp-config`, `--allowed-tools mcp__{server}`, `--tools ""`,
  `--setting-sources project`, `--settings '{"disableAllHooks":true}'` (with project settings
  alone, the user's plugin hooks — Qoder Security, qoder-context-hook — still ran headless),
  `--no-session-persistence`, and every inherited `QODER_*` variable left out of its environment:
  a nested-agent marker makes `-o stream-json` exit 42, and `QODER_MCP_LAZY` puts the server's
  tools behind qoder's own `mcp_get`/`mcp_call` (read as the tool `mcp_call` names; `mcp_get`
  only reads a schema and is no foreign tool). The model sees `mcp__ks<rid6>__<tool>`; a step's
  calls come one after the other, each `tool_use` block printed before it runs.
- **claude** (`claude-stream-json`, each assistant message's usage too): `--mcp-config
  {mcpConfig} --strict-mcp-config` (the token in that 0600 file), `--allowedTools
  mcp__{server}`, `--tools ""`, `--permission-prompts none`, `--disable-slash-commands`,
  `--setting-sources ""` — no settings file and no CLAUDE.md: with `project`, a CLAUDE.md in a
  parent directory of the workspace reached the prompt (2.1.303, against a stub Messages
  endpoint) — `--settings '{"disableAllHooks":true,"autoMemoryEnabled":false}'`,
  `--no-session-persistence`, and `--effort {effort}`. Not the text argv's `--safe-mode`: it
  turns `--mcp-config`'s server off too. Its environment: `MCP_TOOL_TIMEOUT` 30 s past
  `toolResultTimeoutMs` (Claude Code honours it: a 2 s one cancelled a held call at 2 s),
  `MCP_TIMEOUT` the readiness wait, `ENABLE_TOOL_SEARCH=false` (with it on, Claude Code put a
  tool of its own in front of the request's), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and no
  `CLAUDECODE`/`CLAUDE_CODE_*`/`CLAUDE_AGENT_SDK_*` of a session the gateway was started in.
  Auto-memory is off twice, in the argv and the environment, because `--setting-sources ""`
  leaves it on: `~/.claude/projects/<workspace>/memory/MEMORY.md` reached the prompt as
  instructions, with ~2,300 chars telling the model to keep memories with the Write tool, and
  live a "remember that my favourite colour is teal" request reached for Read — the tripwire's,
  a 502. The environment reaches an entry whose `bridge.args` were copied before the argv said
  it. Each tool is listed with `_meta: {"anthropic/maxResultSizeChars": maxPromptChars}`:
  without it Claude Code wrote a result over ~50,000 chars to
  `~/.claude/projects/<workspace>/<session>/tool-results/`, left it there after the session, and
  gave the model a 2 KB preview and the path (live, a 60,000-char result made it reach for Read);
  with it a 190,000-char result reached the model whole and nothing was written. A result over
  `maxPromptChars` is a 400 before it reaches Claude Code. The model sees `mcp__ks<rid6>__<tool>`; asked for two at once, Claude Code sent
  the second tools/call after the first one's result, so a step's calls go out one per answer.
  Claude Code keeps no harness tool here: any other `tool_use` block is the tripwire's. The
  `claude` profile ships it with `toolMode: "auto"`, explicit-only as before. Checked against a
  stub Messages endpoint (the request offered the session's two tools and nothing else) and live
  on 2.1.303 (2026-11-03, `haiku`): a two-turn round trip on each face, two tools of one step.

`keysmith set <id> toolMode auto` on an opencode, codex, qoder or claude entry attached before
this fills in `bridge` (and `emulateArgs`) from the profile, as for agy (`keysmith upgrade claude
--apply` does too). With
`toolMode: "emulate"` there is no bridge and no process held between requests.

`kiro` carries `emulateArgs` (its text argv) and keeps `toolMode: "off"`: its stream was only
ever checked against a stub, because every live run so far was refused by the account's overage
limit before any text. `keysmith set kiro toolMode emulate` turns it on. kiro has no bridge
driver (its ACP mode is a separate, experimental path, and so is codex's app-server
`dynamicTools`; neither is used).

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

### Reasoning effort on a CLI

A request chooses an effort in its API's own spelling — `reasoning_effort` or
`reasoning: {effort}` on `/v1/chat/completions` and `/v1/responses`, `output_config: {effort}`
on `/v1/messages` (two spellings that disagree are a 400) — or, for a client that cannot send
one (OpenBot), in the model id: `codex/gpt-6-astra-xhigh` is `gpt-6-astra` at `xhigh`, the
way agy's own catalogue spells `gemini-4-argon-high`. `GET /v1/models` lists one such id per
level the catalogue gives a model (`keysmith.effort`, `keysmith.upstream`), and a key's scope
decides them as written: `codex/gpt-6-astra*` reaches them, `codex/gpt-6-astra` alone does not.

The level is checked against the CLI's own catalogue and nothing else: `codex debug models`
(`supported_reasoning_levels`, per model: gpt-6-astra takes low, medium, high, xhigh, max and
ultra on codex 0.163), Claude Code's answer to `initialize` (`supportedEffortLevels`: low,
medium, high, xhigh, max on 2.1.303's current models; Haiku 4.5 none), or a declared
`models` entry's `efforts`. A level the model does not list is a 400 that names the ones it
does; a model with no levels, or one the catalogue does not list, takes no effort (400) — never
guessed. A model id and a field that name two levels are a 400. A catalogue that cannot be
read is a 503 for a request that names an effort, and changes nothing for one that does not.

The `codex` profile carries it as `-c model_reasoning_effort="{effort}"`, the `claude` profile
as `--effort {effort}`, on every argv (text, EMULATE, vision, the MCP bridge). A request that
names none runs the argv it always did: the CLI's own default. A CLI whose argv takes no
effort (agy, opencode, qoder, kiro, an entry attached before `{effort}`) is handed none, as
before, and the usage row says so (`effortIgnored`); the row of a run that took one says which
(`effort`). An MCP bridge session keeps the effort it started at: a continuation that names
another effort (in the id or in a field) is a new session, which reads the conversation so far
(the cold path); `codex/gpt-6-astra-xhigh` and `codex/gpt-6-astra` with `xhigh` are one session.

### Claude Code, Qoder and Codex without tools

- `claude`: `--tools ""` (no built-in tool), `--strict-mcp-config` with no `--mcp-config`
  (no MCP server), `--permission-prompts none` (anything that would still ask is denied),
  `--disable-slash-commands`, `--safe-mode` (no CLAUDE.md, plugins, hooks or custom agents;
  auth and model selection stay), `--max-turns 1`. `{noSession}` is
  `--no-session-persistence`: 2.1.261 refuses `--no-session` as an unknown option. All of it
  parsed by 2.1.261 with an empty prompt, which it rejects before sending anything; requests
  went through it on 2.1.303 (images, and EMULATE's argv is this one). It spends your Claude subscription, so the profile ships
  `explicitOnly: true`: no alias, no probe, and a re-add keeps it. A request with an image or
  a PDF runs `visionArgs`: the same switches with `--input-format stream-json` and the prompt on
  stdin (see [Media](#media-images-pdfs-audio-video)).
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
| `mediaHeaders` | — | headers sent with a request that carries media up, and with no other: the `copilot` profile's `{"copilot-vision-request": "true"}`, the header Copilot's own clients send with an image (not checked live here). See [Media](#media-images-pdfs-audio-video) |
| `rawChat` behaviour | automatic | when a request carries `tools`, keysmith forwards the body verbatim to the first HTTP candidate and streams its answer unchanged, so real `tool_calls` survive. When every candidate refuses, the client gets the refusal with the provider's own status (and `retry-after`) — an earlier leg's 429/503 over a later leg's other refusal |
| `thoughtSignatures` | `false` | Gemini 3 (the `google` profile): remember `tool_calls[].extra_content.google.thought_signature` as answers pass through the tool relay, and put it back on a replayed call that lost it — the same call: same gateway key, id, function name and (parsed) arguments, told apart by the conversation before it when that is not enough; a call with no function name gets nothing. `true`, or `{ "maxEntries": 4096, "maxBytes": 16777216, "maxAgeMs": 21600000 }`; in memory, one store per upstream URL shared by every adapter on it (the largest limits win), never logged |
| `stripModelPrefix` | — | dropped from ids `/models` returns: `"models/"` for Google, whose listing says `models/gemini-3.8-flash` and whose requests take `gemini-3.8-flash`. A key's deny glob holds for both spellings: `google/gemini-4-*` keeps `google/models/gemini-4-argon` out too |
| `modelParams` | — | request fields sent with one upstream model: `{ "gemini-4-argon": { "reasoning_effort": "high" } }`, `"*"` for every model of the adapter. Under the fields keysmith builds (model, messages, stream… always win). On a plain completion keysmith builds the body, so this is what decides; on the tool relay the client's body goes verbatim and a field it set itself wins. A client that chose its effort in any spelling — `reasoning_effort`, `reasoning`, or Google's `thinking_config` under `extra_body.google` or `google` — gets no effort field from here at all (Google refuses `reasoning_effort` beside a thinking budget). A value that is not an object of fields is a load error, and `keysmith set` refuses it |

Upstream statuses: 401/403 stay auth errors, 429 and 503 keep their status (with
`retry-after` when the provider sent one) on the plain-completion path too; anything else
there is a 502. A streamed request holds its headers until its first event, for up to
`limits.streamHoldMs` (default 10000) — an EMULATE leg asking agy again does not end the hold —
so a refusal in that time keeps its status; one after that is an SSE error frame on a 200 (an `error` event on `/v1/messages`). An open stream that has
nothing to say for `limits.streamKeepaliveMs` (default 15000; 0 turns it off) gets a keepalive —
an SSE comment on `/v1/chat/completions`, a `ping` event on `/v1/messages` — so a slow CLI or a
buffered tool answer is not cut by a proxy's idle timeout. When failover moved on from a 429/503 and a later leg
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
