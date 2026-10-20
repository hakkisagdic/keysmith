# keysmith

**Forge an API key out of any coding CLI.**

You already pay for Command Code, opencode, Claude Code, Qoder, Kiro, Copilot — and their
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
node src/cli.js init                 # writes ~/.config/keysmith/config.json (0600) + one API key, shown to your terminal only
node src/cli.js add agy              # attach a built-in profile (a tool-less one: see "Agents that could act on this machine")
node src/cli.js add evren --base-url https://your-gateway/v1 --key '{json:~/.local/share/opencode/auth.json#evren.key}'
node src/cli.js doctor               # is each adapter actually alive, and what does it cost
node src/cli.js serve --tunnel       # http://127.0.0.1:8787/v1 (+ Cloudflare tunnel)
```

Point anything at it:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEYSMITH_KEY" -H 'content-type: application/json' \
  -d '{"model":"agy/gemini-3.8-flash-low","stream":true,"messages":[{"role":"user","content":"one-line haiku"}]}'
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
| `GET /v1/keysmith/routes` | adapters, aliases, limits and any unusable alias leg (`alias_warnings`) as JSON |
| `GET /v1/keysmith/usage?hours=24&tail=50` | request counts per model, latest entries |
| `GET /` | status page in a browser: post the key once through its form, a cookie opens it for an hour |
| `GET /healthz` | keyless liveness probe for a supervisor |

Everything under `/v1` needs `Authorization: Bearer <key>`, `x-api-key`, or `?api_key=` (the
last for clients that cannot set a header; a URL is kept by shell history, browsers and a
tunnel's request logs, so prefer the header). A key can carry a scope — the adapters, models
and aliases it may reach — and every route above answers it with that share only; see
[Keys with a scope](#keys-with-a-scope-what-each-key-may-reach).
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

Aliases are edited from the command line, so a live config never has to be opened (it holds
the gateway key):

```bash
keysmith alias                                              # every alias and its legs
keysmith alias argon agy/gemini-4-argon-high google/gemini-4-argon   # set a chain
keysmith alias chat --prepend agy/gemini-4-argon-high       # a new first leg; the others keep their order
keysmith alias chat --append ollama/qwen3:4b                # a new last leg (a leg already there moves)
keysmith alias chat --drop ollama/qwen3:4b                  # take one out
keysmith alias chat --delete
```

A leg has to name an attached adapter (`--force` saves one you have not attached yet), an
alias cannot name another alias or share an adapter's name, and an
[explicit-only or tool-capable adapter](#agents-that-could-act-on-this-machine) is refused —
`--force` or not; an adapter whose argv carries an auto-approve flag counts as tool-capable
whether it is marked or not. After a change the same checks `doctor` runs are printed, so a
model the adapter does not list is said then, not discovered as a slow failover later.

The gateway reads its config once, when it starts. `add`, `remove`, `set`, `alias` and
`key add|scope|revoke` change the file, not the running gateway: while one runs they say so, with
the restart command (`launchctl kickstart -k gui/$UID/dev.keysmith.gateway` under launchd,
`keysmith stop && keysmith start` otherwise), and `keysmith status` says when the config is
newer than the gateway. Until then a new alias is a 404, a disabled adapter keeps answering,
a revoked key keeps working and a key keeps the scope it had.

Which is also why a typo in a chain is invisible at request time: a leg naming an adapter
you do not have gets skipped, and a leg naming a model the adapter never heard of gets
rejected upstream and failover'd — both look like a slightly slow provider, while quietly
answering from a route you did not choose and did not price. So keysmith reads every alias
leg off the config at startup and names the unusable ones in `keysmith doctor`, on the
status page, in `GET /v1/models` (`keysmith.errors`) and in
`GET /v1/keysmith/routes` (`alias_warnings`). A leg pointing at a *dynamic* catalogue (a CLI
with no `models` declared) can't be checked without spawning it — that's what
`keysmith doctor --probe-models` is for.

Per-adapter knobs that shape a route: `priority` (orders the flat listing), `disabled`,
`timeoutMs`, `maxConcurrent` (a semaphore, so five browser tabs cannot fork five agents),
`stripSystemPrompt`, `maxPromptChars`, `headers`, `modelMap`, `modelParams`, `defaultModel`,
`explicitOnly`, and `toolMode` (whether a CLI leg takes tool requests, see
[Tool calls](#tool-calls-thinking)). One field of an attached adapter changes with
`keysmith set <adapter> <field> <value>` (the value is JSON when it parses, a string
otherwise; `--unset` removes the field; nothing is echoed back, since the field may be
`apiKey`). A value the gateway would refuse to load — a `modelParams` that is not an object
of fields, an `args` with an auto-approve flag, an http adapter without `baseUrl` — is refused
before it replaces a working entry (`--force` saves it anyway, and says the adapter will not
load); credentials are not resolved for that check, so a key only launchd can see is fine.

## Sessions: multi-turn out of a stateless client

OpenAI clients resend history; CLIs *are* stateful. keysmith hands back an opaque
`kss_…` id (in the body, in `x-keysmith-session`, and in the last SSE chunk) and maps it
onto the upstream session — `cmd --resume`, `opencode --session`. Send it back on the
next request and the CLI continues its own thread, which is also how you get prompt
caching. Sessions live in memory: restart the gateway and clients start fresh.

## Tool calls, thinking

A request that offers tools — `tools` (or the older `functions`) on `/v1/chat/completions`,
`tools` on `/v1/messages` — walks its route in the order the route was declared, and each leg
takes the tools the way it can:

- **An HTTP upstream** on the openai wire gets the client's body verbatim (`passthrough`), on
  `/v1/chat/completions`; its answer comes back byte for byte. `/v1/messages` has no verbatim
  relay, so there its HTTP legs are passed by.
- **A CLI with a `toolMode`** answers through a tool engine. The CLI runs without tools of its
  own, as it does for text; the model writes its calls, and keysmith hands them to the client
  as `tool_calls` (`tool_use` blocks on `/v1/messages`), streamed or not, with keysmith's own
  ids. keysmith never runs a tool: the client does, behind its own approvals, and sends the
  result back on its next request.
- **A CLI without one** (`toolMode` absent or `off`: every built-in profile but `agy`) is
  passed by.

That is a change of order for a route that mixes the two: a CLI leg with a `toolMode` now takes
tools where it stands in the chain. In `argon` (`agy/gemini-4-argon-high`, then
`google/gemini-4-argon`) a tool request goes to agy first, and to Google when agy fails before
answering. `keysmith set agy toolMode off` puts it back the way it was.

`toolMode`, per CLI adapter:

| Mode | What answers a tool request |
|---|---|
| `off` (absent) | nothing: the leg is passed by |
| `emulate` | EMULATE, below |
| `mcp` | the MCP bridge, below, always: a `tool_choice` that forces a call is a 400 (MCP cannot make a model call a tool), a bridge with no room a 503 with `retry-after`, a CLI with no bridge driver (only agy has one) a 503 |
| `auto` | the bridge where it can take the request, EMULATE otherwise, and EMULATE in the same request when the bridge fails before any call went out. `tool_choice: "none"` is a text answer; `required` or a named tool is EMULATE (MCP cannot make a model call a tool); tool names too long for the bridge, a bridge with no room, a CLI with no bridge driver is EMULATE — with the reason in the usage row (`fallback`: `name_too_long`, `bridge_full`, `no_bridge`, or what made the bridge fail: `unknown_agent`, `ready_timeout`, …) |

There is no mode that runs both engines at once and takes the faster: it would spend the
CLI's quota twice per turn for what the fallback gives anyway.

**EMULATE.** The request's tools (their schemas as sent), the rules its `tool_choice` and
`parallel_tool_calls` set, and the whole conversation — earlier calls and their results
included — are written into one prompt that asks for exactly one JSON object back:
`{"tool_calls":[{"name":…,"arguments":{…}}]}` or `{"final":"…"}`. The reply is read strictly:
that object alone, or alone in one ```` ```json ```` fence. Prose around it, a second object,
another key, a call the client's own schema refuses (unknown tool, missing or extra
arguments, a wrong type), a final answer where `tool_choice` asks for a call, two calls where
parallel calls are off — each is an invalid reply, asked for once more with the reason in
front (not the reply), inside the same `timeoutMs`. A second invalid reply is a 502
`tool_emulation_error` that says why; a reply is never passed on as text in place of a call.
On a stream nothing of the answer goes out until the JSON is whole and checked — the client
gets keepalives meanwhile — and calls then arrive the way a provider streams them. Every turn
renders the whole transcript again: no CLI session is resumed on this path, and no
`x-keysmith-session` is handed back. A tool result is the least trusted text in the prompt:
it is fenced with a per-request nonce no text of the request contains, and the prompt says it
is data, not instructions. The most an instruction hidden in one can do is make the model
write a call — checked against the client's schema, then the client's to approve, as a
provider's would be.

**The MCP bridge** (agy, `toolMode` `auto` or `mcp`). agy runs with one MCP server whose tools
are the request's own, and the model calls them the way it calls any tool. That server is
keysmith: agy starts a shim (`node src/bridge/shim.js`) that relays to the gateway over a Unix
socket — 0600, under `~/.local/share/keysmith/run/`, no TCP, so no tunnel reaches it — with a
token per session. A call the client's schema refuses goes back to the model with the reason,
and the model tries again (three such calls in one turn fail it). A call that fits goes to the
client as `tool_calls`, with keysmith's id, and the HTTP answer ends there, while agy waits in
the same process on its call. The client runs the tool and sends the result in its next
request, as it would to a provider: keysmith finds the session the call belongs to and gives
agy the result as the call's MCP result, and what agy does next — text, or its next call — is
that request's answer. A turn after the first sends agy one tool result, not the transcript
again. agy runs the calls of one step one after another, so a step with three calls is three
HTTP turns of one call each, whatever `parallel_tool_calls` says. Text the model writes before
a call stays in the answer that carries it.

A request continues a session only when it is the same conversation: its last assistant turn
holds the call the session waits for and the result follows it, it comes with the same gateway
key, for the same target, with the same tools and the same system and user turns. Anything else
— another key presenting a valid id, an edited history, a session that is gone — runs on a new
session whose prompt carries the conversation so far, earlier calls and fenced results written
the EMULATE way (the cold path; a result for a session that expired is logged as late). A
second request carrying a result that another request is already answering is a 409.

- **Clock.** `bridge.readyTimeoutMs` (30 s): agy lists the bridge's tools within it, and until
  it has, nothing of the answer goes out — so a session that fails before that (an agent agy
  cannot find, a shim that never connects, an exit) leaves the same request to EMULATE under
  `auto`. `timeoutMs` counts agy generating only, up to its next call or its end.
  `bridge.toolResultTimeoutMs` (300 s) is how long a session waits for the client's result;
  then agy is stopped and its files removed, and the result, when it comes, is answered on the
  cold path — a tool behind a slow human approval still works, at the price of a cold turn.
  `bridge.sessionMaxMs` (30 min) and `bridge.maxTurns` (32 calls) cap a session; past them the
  conversation goes on on a new one. A client that leaves in the middle of a turn stops agy.
- **Room.** Each waiting session is a live agy process — about 1 GB measured on agy 1.4.2, most
  of it the MCP servers of your own agy config, which agy starts for every run although the
  session's agent inherits none of them (they are not offered to the model: a one-tool turn cost
  ~1,300 input tokens). So `bridge.maxSessions` is 2 per adapter, `limits.bridge.maxSessions` 2
  in all, and `limits.bridge.maxSessionsPerKey` 1 — a key that opens a session over its share
  gives up its oldest waiting one. With no room, `auto` is EMULATE and `mcp` a 503. A waiting
  session holds no process slot (`maxConcurrent`), so agy's text requests are not held up by
  clients running tools.
- **What agy may call.** The session's agent is as tool-less as `keysmith-tools` — `tools: []`,
  no inherited MCP servers or customizations, no harness sections, no hooks — with the request's
  tools as its only ones, each `eager` (agy's lazy `call_mcp_tool` is refused headless). A call
  in agy's stream to anything but the bridge's tools (`mcp_ks<rid6>_…`) and `manage_task` stops
  the run: the request is a 502 that is never retried as EMULATE, and the log says
  `SECURITY … foreign tool`. keysmith still runs no tool.
- **Files.** `.agents/agents/ks-b-<rid>.md` in agy's workspace (0600; it holds the session's
  token) and agy's schema cache for the server, `~/.gemini/antigravity-cli/mcp/ks<rid6>/` —
  both removed when the session closes, and every session is closed when the gateway stops. A
  gateway that was killed leaves them; the next `keysmith serve` removes the ones older than an
  hour.
- **What it rests on.** agy 1.4.2 behaviour no document promises: `mcpServers` as a list, the
  `eager` key, the `mcp_<server>_<tool>` names, the `server/discover` it asks first, the schema
  cache. An agy that changes one fails the readiness gate, and `auto` answers with EMULATE.

The usage row of a bridge turn says which session answered and how it was reached:
`"bridge": {"session": "ks3f9a0c", "path": "new" | "attached" | "cold", "turn": 2}`.

**When no leg answers with tools.** A leg that fails before anything reached the client hands
the request to the next one; a call handed to the client is an answer, never retried
elsewhere. If every leg could take the tools and each one refused (a 429, a 400), the client
gets the refusal with the provider's status and message — not the same request again without
its tools. Otherwise, for `tool_choice` `auto` or `none`, the legs that were not tried answer
as a plain completion, without tools, and the log names each leg that refused and its status;
for `required` or a named tool the client gets an error — the last leg's refusal, or a 400
saying no leg takes tools — never text in place of the call it asked for. A tool no CLI can
honour (an OpenAI `custom` tool, an Anthropic server tool such as `web_search_*`) passes every
CLI leg by and is a 400 naming it when no HTTP leg relays it. A request that offers more than
128 tools (`tools` and the older `functions` together; OpenAI's own limit) is a 400 before any
leg is asked, on both faces.

A streamed request holds its headers for `limits.streamHoldMs` (below). An EMULATE turn on
Argon takes 9–44 s, so the stream usually opens before its answer is known; an HTTP leg that
the route falls over to after that carries on in the open stream, as long as the client has
had SSE comments only — once keysmith wrote a frame of its own (reasoning the client asked
for), that leg is not asked at all, since its answer could not go out. A `tool_emulation_error`
inside the hold is an HTTP 502, streamed or not; after the stream opened it is the stream's
error frame (an error chunk and `[DONE]`; an `error` event on `/v1/messages`), which the
`openai` SDK raises as an `APIError` with no status and does not retry on its own.
`x-keysmith-mode` says `passthrough`, `emulate` or `mcp` — on a stream, the engine that was
running when the headers went out, and none when the route fell back to a plain completion.
The usage row says which engine answered (`toolMode`), how many calls it handed over
(`toolCalls`), `retries`, and why the engine is not the one `auto` picks first (`fallback`);
never an argument or a result. What a tool engine spent is in the row even when it failed: a
502's row has its `usage`, `toolMode` and `retries`; a bridge turn that spent a model step and
then failed before any call (`auto` answering the same request with EMULATE) is counted in that
answer's `usage`, the client's included; when a tool leg failed and a later leg
answered (or failed too), `usage` and `retries` count every leg, and `failedLegs` names each
tool leg that failed before — target, engine, status, its own `retries` and `usage`.
`GET /v1/keysmith/routes` lists each adapter's `tool_mode`, and the status page marks it.

`keysmith set <adapter> toolMode auto` (or `emulate`) on an adapter attached before toolMode
existed fills in what the engine needs and the entry lacks — `emulateArgs`, `bridge`, and
agy's `keysmith-tools` agent file — from the built-in profile that runs the same binary with
the same parser; it never replaces a field the entry has. A CLI marked `unsafeTools` never
takes a `toolMode` (a load error), and neither does an HTTP adapter.

An upstream's 429 and 503 keep their status on every path, with its `retry-after` when it
sent one, so a client backs off the way it would talking to the provider directly. When
failover moved on from a 429/503 and the next leg refused for a reason of its own, the
client gets the 429/503: that is why the route failed. A streamed request holds its headers
until the first event that is part of its answer (text, a call, reasoning, an error) — an
engine asking its CLI again, or saying which engine runs, does not end the hold — for up to
`limits.streamHoldMs` (10 s), so a refusal in that time keeps its status too; one that comes
later — a CLI or a model slower than that, an error in the middle of an answer — is an SSE
error frame on a 200. Auth failures stay 401/403; other
upstream failures are a 502.

## Gemini with tools: the `google` profile

```bash
keysmith add google                                              # reads {env:GOOGLE_API_KEY}
keysmith add google --key '{dotenv:~/project/.env#GOOGLE_API_KEY}'  # or where the key already lives
```

Google's own OpenAI-compatible endpoint
(`https://generativelanguage.googleapis.com/v1beta/openai`), so `google/gemini-3.8-flash`
is the API itself: `tools`, `tool_choice`, streaming and `tool_calls` go through verbatim,
which the `agy` CLI adapter cannot do. The catalogue drops Google's `models/` prefix
(`stripModelPrefix`), so ids read the way requests send them.

**Thought signatures.** Gemini 3 returns an opaque signature with each step's function
call — `tool_calls[].extra_content.google.thought_signature`, streamed or not — and refuses
the next turn if a replayed call comes back without it (`400 INVALID_ARGUMENT: Function call
is missing a thought_signature in functionCall parts`). Most OpenAI clients, LangChain's
`ChatOpenAI` among them, rebuild the assistant message from the fields they know and drop
it. With `thoughtSignatures: true` (on in the profile) the adapter reads the answer as it
passes — the bytes reach the client unchanged — keeps each signature, and on the next request
puts it back on a call that arrived without one. Only on the call it came with: Gemini's ids
are short (`call_10078`), and two conversations, or two steps of one, draw the same id. So a
signature is kept under the gateway key the request came with, the call id, the function
name and the arguments (compared parsed, since clients re-serialize them); calls that agree
on all of that are told apart by the conversation before them. A call that names no
function, comes with another gateway key, or cannot be told apart gets nothing, and Gemini's
400 reaches the client. A signature the client did send is left alone. The store lives in
the gateway's memory, one per upstream URL — every adapter on that endpoint shares it, so a
failover leg to a second key can put back what the first leg saw: 4096 entries, 16 MiB,
6 hours, whichever comes first (`"thoughtSignatures": {"maxEntries": …, "maxBytes": …,
"maxAgeMs": …}` to change them; the largest any adapter asks for wins), and it is never
logged. A call the gateway never saw — before a restart, from another process —
gets nothing, and Gemini's 400 reaches the client: Google's documented bypass value
degrades the model, so keysmith does not send it.

Checked live on 2026-10-16 (gemini-3.6-flash): the replayed history without the signature
was refused with that 400, and the same history through the adapter answered.

**Quota.** On the free tier each model allows about 20 requests a day per project — a 429
`RESOURCE_EXHAUSTED` that keysmith passes on as a 429 — and the count is the key's, shared
with anything else that uses the same key, such as a direct `google:` client. A tool loop
spends one request per step.

A CLI that emits thinking (`cmd`, Claude, opencode) keeps it to itself unless the request
says `"include_reasoning": true` — then it arrives as `delta.reasoning_content` on
`/v1/chat/completions`. The other two faces drop it.

## Gemini 4 Argon at its highest effort

Two routes reach it, and they spell the effort differently:

- **agy** puts the effort in the model id: `agy/gemini-4-argon-low|medium|high`. `high` is
  Argon's maximum — agy refuses `--effort max` and `--effort xhigh` for it. Through the
  tool-less `keysmith-text` agent, `agy/gemini-4-argon-high` answered "Reply with exactly: OK"
  in 3.2 s. A request with tools is answered too (`toolMode: "auto"` in the profile): the
  tool-less `keysmith-tools` agent writes the calls, EMULATE hands them over (see
  [Tool calls](#tool-calls-thinking)).
- **google** (the API) lists `gemini-4-argon`, takes tools, and takes OpenAI's
  `reasoning_effort` field. keysmith builds the body of a plain completion itself, so the
  effort goes in the adapter's `modelParams`, which is sent with that model and no other:

  ```bash
  keysmith set google modelParams '{"gemini-4-argon":{"reasoning_effort":"high"}}'
  ```

  On the tool relay the client's body goes upstream verbatim; `modelParams` fills in only
  what the client did not set, so a client that chose its own effort keeps it — in any
  spelling: `reasoning_effort`, `reasoning: {effort}`, or Google's `thinking_config` (under
  `extra_body.google` or `google`). Then no effort field from `modelParams` is added at all:
  Google's documentation says `reasoning_effort` and a thinking budget cannot be used
  together, and that 400 would count as the leg refusing the tools. `high` here matches agy's
  `-high`; the Google leg was not run live with it.

So one alias drives Argon both ways, agy first:

```bash
keysmith alias argon agy/gemini-4-argon-high google/gemini-4-argon
```

A plain request is answered by agy and fails over to the API. A request with `tools` goes to
agy as well when its adapter has a `toolMode` (`keysmith add agy` brings `auto`), and to the
API leg when agy fails before answering; an agy entry with no `toolMode` (one attached before
it existed) passes tool requests to the API leg, as it always did. Each leg spends its own
quota: your Antigravity login for agy, the API key's (free tier: about 20 requests a day per
model) for google.

## Agents that could act on this machine

A CLI adapter runs an agent, and an agent has tools: a shell, file edits, MCP servers. Behind
a tunnel, a request that can reach such an adapter can make it act on this machine. So every
built-in CLI profile that can be made tool-less is: it runs in an empty directory keysmith
owns (`~/.local/share/keysmith/workspaces/<name>`), with the CLI's own switches for "no
tools", and no auto-approve flag. The ones that cannot are marked `unsafeTools` and ship
disabled. Every CLI profile has its own workspace — under launchd the gateway's working
directory is keysmith's source tree, and no agent runs there; `keysmith add custom` gives a
hand-written adapter one too.

| Profile | How its tools are taken away | Checked |
|---|---|---|
| `agy` | `--agent keysmith-text`: an agent file with `tools: []`, no MCP, no customizations; `stopAtToolCall` for the one tool agy keeps. A tool request (EMULATE) runs `--agent keysmith-tools`, the same `tools: []` agent with the JSON protocol as its prompt: the calls go to the client, agy runs none | live, agy 1.3.3; the tool protocol probed on agy 1.4.2 |
| `agy`, MCP bridge | a tool request on the bridge runs `--agent ks-b-<rid>`, a session agent as tool-less as `keysmith-tools` whose one MCP server is keysmith (a Unix socket, a token per session) offering the request's tools and nothing else; each call goes to the client, never run by agy or keysmith; a call to any other tool stops the run (502, the tripwire) | stub agy in the tests; the MCP shape (list, `eager`, `mcp_<server>_<tool>`, `server/discover`, a held tools/call) probed on agy 1.4.2; live, agy 1.4.2 on gemini-3.8-flash-low: two turns of one call through both faces on one agy process, nothing left after |
| `kiro` | `--agent keysmith-text`: `tools: []`, `mcpServers: {}`, `includeMcpJson: false`, `resources: []`; `--trust-tools=` trusts nothing; `stopAtToolCall` | argv and agent file accepted by kiro-cli 2.27.1; its first live run was refused for quota before any text |
| `claude` | `--tools ""`, `--strict-mcp-config`, `--permission-prompts none`, `--disable-slash-commands`, `--safe-mode`, `--max-turns 1` | parsed by Claude Code 2.1.261; no live request sent |
| `qoder` | `--tools ""`, `--strict-mcp-config` | parsed by qodercli 1.1.59 |
| `codex` | `--disable shell_tool`, `--sandbox read-only`, `approval_policy="never"`, `web_search="disabled"`, `--disable goals`, `--ignore-user-config` (no MCP servers from your config), plugins/apps/browser/computer-use off, `agents.max_threads=1` | a stub Responses endpoint, codex 0.163.0: gpt-5.5 is offered request_user_input and apply_patch (the read-only sandbox refuses it); gpt-6-* keep code mode's exec (no shell) and sub-agent tools no switch removes — capped at one sub-agent |
| `opencode` | `--agent keysmith-text` (`permission: {"*": deny}`, `tools: {"*": false}`) and a workspace `opencode.json` denying every tool to any agent; no `--auto`; `stopAtToolCall` | a stub OpenAI endpoint, opencode 1.18.27: no tools offered, a bash call the model made anyway ran nothing; its free tier (`opencode/*`) refuses this run with a 403 |
| `cmd` | — (cannot be done: a `-p` run approves its own tool calls) | `unsafeTools`; Command Code 1.81.0's bundle |
| `gemini` | — (never run from here) | `unsafeTools` until a tool-less argv is checked against a real install |
| `warp` | — (cannot be done, see below) | `unsafeTools` |

Two marks keep an adapter out of routes it was not asked for by name:

- **`explicitOnly: true`** — the adapter answers a request that names it (`claude/sonnet`)
  and nothing else: never an alias leg (`keysmith alias` refuses it; a hand-edited leg is
  skipped and named in `doctor`, `/v1/models` and the routes endpoint), never probed by
  `doctor --probe-models`. For an adapter that spends something you keep for yourself; the
  `claude` profile ships it, and `keysmith add <profile> --explicit-only` sets it on any other.
- **`unsafeTools: true`** — keysmith could not take the CLI's tools away. Everything
  `explicitOnly` does, and the profile ships `disabled: true`. Serving it is a decision with
  its own flag: `keysmith set <id> disabled false --allow-unsafe-tools`, and so is any later
  change to what it runs or how it is stopped — `stopAtToolCall`, `args`, `resumeArgs`,
  `bin`, `env`, `cwd`, `parser`, `modelsFrom`; only `note`, `models`, `defaultModel`,
  `priority`, `timeoutMs`, `maxConcurrent`, `maxPromptChars` and `explicitOnly` change
  without it, and turning it off never needs it. Its profile also sets
  `stopAtToolCall: "always"` where the parser can see tool calls: the run is stopped at the
  first one it reports, and a call before any text fails the request. That limits the damage,
  it is not a sandbox — the harness may have started the command by the time keysmith sees
  the call.

An argv with an auto-approve flag (`--auto`, `--yolo`, `--dangerously-skip-permissions`,
`--full-auto`, `--trust-all-tools`, `--permission-mode yolo`, `--sandbox danger-full-access`,
agy's `--mode auto` and `--mode accept-edits`, …) — in any of its templates: `args`,
`resumeArgs`, `emulateArgs`, the bridge's `args` — does not load unless the entry is marked
`unsafeTools`: the gateway reports it as a load error (`doctor`, `/v1/models`, the routes
endpoint) and a request to it is a 503 naming the flag. An entry marked `unsafeTools`, in turn,
never takes a `toolMode` other than `off` (a load error too): a CLI that kept its own tools is
never handed a tool request. A config written by an older keysmith — the `opencode` profile
used to pass `--auto` — stops there; `keysmith add opencode --as <id>` copies the tool-less
argv over it. A re-add never drops a guard: `explicitOnly`, `unsafeTools`, `disabled` and a
`toolMode: "off"` on the entry it replaces are kept, and it says so — taking one off is a
`keysmith set`. The mark brings `toolMode: "off"` with it: a re-add that keeps `unsafeTools`
over a profile with a tool engine (agy's `auto`), and `keysmith set <id> unsafeTools true`,
turn the engine off and say so.

**Warp (`oz`) is the `unsafeTools` one.** `oz agent run` takes an agent profile by id;
profiles are made in the Warp app, the default one lets the agent run commands and edit
files, and the permission values a profile has only ask or allow — none denies. Nothing on
`oz`'s command line removes the tools. Every run is also recorded in your Warp account (a
`run_url` on oz.warp.dev). `/usr/local/bin/warp-cli` is Cloudflare WARP, a VPN client — the
profile uses the `oz` inside Warp.app.

**Command Code (`cmd`) keeps its tools.** A `cmd -p` run answers every tool confirmation
itself with "allow" (Command Code 1.81.0: a headless run is `autoAllow`), and `-p` withholds
only its interactive tools (ask_user_question, plan mode, todo_write, cron, taste) — shell,
read, write and edit stay, and `--max-turns 1` limits the turns after a call, not the call. So
`cmd` is `unsafeTools`: it ships disabled, and when served it is stopped at its first
`tool_queued` event, which comes before its permission check. A `cmd` adapter attached
before this keeps serving until it is re-added (`keysmith add cmd`, which arrives disabled) or
switched off (`keysmith set cmd disabled true`).

**Claude Code: attached, not used.** The `claude` profile is tool-less and explicit-only as
shipped, so `keysmith add claude` puts it in no alias and no probe, and a re-add (to pin its
`bin`, say) keeps it that way. That is what a setup whose own work runs on the same Claude
subscription needs: every request to `claude/…` spends that subscription.

**Ollaya** ([ollaya.dev](https://ollaya.dev)) is out of scope: it is a local runtime for
decision models — typed questions answered with calibrated probabilities over their
options, on `/v1/decisions` and `/v1/systemone` — not a chat-completion API, so there is no
`/v1/chat/completions` for an adapter to forward to.

## Secrets stay out of the config

An adapter's `apiKey` is a *reference*, resolved at load and never written to a log:

```json
"{env:OPENAI_API_KEY}"
"{file:~/.config/keys/copilot}"
"{json:~/.local/share/opencode/auth.json#evren.key}"
"{dotenv:~/project/.env#GOOGLE_API_KEY}"
"{exec:security find-generic-password -s copilot-api -w}"
"sk-live-…"
```

The `{json:…}` and `{dotenv:…}` forms are the ones that matter: they reuse a credential an
agent or a project already keeps, so you never paste a key twice and nothing secret lands
in this repo. `{dotenv:…}` reads one `NAME=value` (or `export NAME=value`, quoted or not)
and executes nothing; a LaunchAgent does not see your shell's exports, so it is also how a
gateway under launchd reaches a key a project's `.env` holds. A literal works too, but the
file is `0600` for a reason.

A provider key is redacted the way the gateway key is: once an adapter has resolved it,
every log line, usage row, error message (the client's included) and the status page show
`AIza…39 fp:…` in its place, and anything shaped like a Google key (`AIza` + 35) is taken
out even when nothing here registered it.

## The gateway key, and what is logged

The key clients send (`ks_…`) is printed in full by `keysmith init --reveal` and
`keysmith key list|add --reveal` only, and only when stdin and stdout are an interactive
terminal; `keysmith key add <label> --out <file>` writes a new one to a new 0600 file instead. A terminal alone is not enough: a coding agent's terminal tool (tmux, expect,
`script`) opens a real one, and what it reads lands in a transcript — `--reveal` is the word
it has to type on purpose. Without it, piped, redirected or under launchd, those commands
print the redacted form instead, and so does everything else keysmith writes:

```
ks_Q…35 fp:3f9a0c12      first 4 characters · length · first 8 hex of sha256(key)
```

`keysmith key revoke fp:3f9a0c12` takes that fingerprint, and only that: a key on the
command line is in shell history and in every local user's `ps`. A script that needs the
key itself reads it from the config into a variable, never onto stdout:

```bash
KEY=$(jq -r '.auth.keys[0] | .key? // .' ~/.config/keysmith/config.json)   # a bare key, or one with a scope
```

An agent gets a key of its own instead, written to a file only it reads:
`keysmith key add <label> --deny … --out <file>` (see [Keys with a scope](#keys-with-a-scope-what-each-key-may-reach)).

| file (in `~/.local/share/keysmith/`) | written by | holds |
|---|---|---|
| `launchd-gateway.log` | launchd: `serve`'s stdout + stderr | start banner (address, adapters, the key redacted, tunnel URL); with `KEYSMITH_VERBOSE=1`, adapter failures, retries and skipped alias legs |
| `keysmith.log` | `keysmith start`: the same stream | the same, for a gateway started without launchd |
| `usage.jsonl` | the gateway, one line per request | time, model, status, duration, token counts, stream flag, user agent, error message, `retries`/`cutAt`; for a tool request `toolMode`, `toolCalls`, `fallback` and `failedLegs` (see [Tool calls](#tool-calls-thinking)); the key's fingerprint (`key: "fp:…"`) and its scope's decision (`scope`, `skipped`) |
| `launchd-tunnel.log` | launchd: cloudflared | cloudflared's own output |

keysmith does not log prompts, answers, request headers or request URLs, and a request
whose URL does not even parse is answered 400 without a word about it. The status page does
not take `?api_key=` at all: it asks for the key in a form, and keeps a cookie that opens
that page alone, for an hour. Error messages can quote anything a CLI printed, so every log
line and every usage row goes through the same redaction: the configured keys — as written,
as JSON escapes them, and any run of 12 or more of their characters a cut left behind — and
anything shaped like a minted key, whole or cut, come out as above. Messages are redacted
before they are shortened, streamed text (`keysmith chat --stream`, cloudflared's output)
is redacted across the pieces it arrives in, and an error nothing caught is reported
redacted too. The files are `0600` in a `0700` directory; `serve`, `start` and
`install-service` tighten older ones, and the launchd agents run with `Umask` 077, so a log
launchd re-creates after it was deleted or rotated is `0600` as well. Logs from a keysmith
older than this still hold the key in full:

```bash
keysmith scrub-logs                 # the logs and their rotated copies, rewritten in place; counts only, never a key
keysmith scrub-logs path/to/file…   # and any other file the key reached: another KEYSMITH_DATA, a transcript
```

A scrub rewrites what it can reach. A key that was in a log may also be in copies it
cannot — backups, rotated archives, an agent's transcript — so when `scrub-logs` finds a
configured key it says to rotate it: `keysmith key add --reveal` in a terminal, move the
clients over, `keysmith key revoke fp:<old>`, restart the gateway. `keysmith status` says
when the running gateway is older than the code or the config on disk and needs that restart.

## Keys with a scope: what each key may reach

A bare key in `auth.keys` reaches every adapter and every alias. That is what every key did
before scopes, and what a key nobody scoped still does. A key can instead carry an `allow`
list, a `deny` list, or both:

```json
"auth": {
  "enabled": true,
  "keys": [
    "ks_…",
    { "key": "ks_…", "label": "ada",   "deny":  ["claude-api"] },
    { "key": "ks_…", "label": "scout", "allow": ["agy", "alias:argon"] }
  ]
}
```

| pattern | matches |
|---|---|
| `claude-api` | an adapter id: every model of that adapter |
| `agy/*`, `google/gemini-3.8-*` | a glob over `adapter/model`; `*` is any run of characters, `/` included |
| `alias:argon`, `alias:*` | an alias, by name |

- No `allow` list means everything that is not denied. An `allow` list means only what it
  names, aliases included: an allow-listed key names each alias it may use (`alias:argon`).
- `deny` wins over `allow`.
- An alias is checked twice: the key may name it, and then each leg on its own. A leg outside
  the scope is **skipped** — never run, so its provider never hears of the request — and the
  next leg answers; the request is refused only when no leg is left. It is the leg that is
  checked, not the alias, so a leg added to an alias later cannot take a key past its scope.
- A glob is checked against the model as requested and, when the adapter's `modelMap` rewrites
  it, as sent upstream. A bare adapter id (`claude-api`) is checked with its `defaultModel`; with
  none, a key whose scope covers only some of that adapter's models is refused — it has to name
  the model, since the upstream would otherwise pick one.
- A glob is a string match on the id as written, not a spending limit. keysmith knows one other
  spelling and checks a deny against it too: an adapter with `stripModelPrefix` (Google's
  `models/`) answers `google/models/gemini-4-argon` as `gemini-4-argon`, so `google/gemini-4-*`
  keeps both out. What else an upstream treats as the same model — a dated snapshot and its
  undated alias, say — it cannot know. To keep a credit out, deny the adapter id
  (`claude-api`), or give the key an allow-list.
- A request outside the scope is a **403** (`permission_error`) whose message names the adapter
  and never the key. Every face enforces it the same way: `/v1/chat/completions` (the tool relay
  included), `/v1/messages`, `/v1/responses`, `/v1/embeddings`.
- What a scoped key can list is its share: `/v1/models` (an alias with only the legs it may
  run), `/v1/keysmith/routes`, `/v1/keysmith/usage` and the status page, whether it is opened by
  header or by the cookie its own login set. An adapter the key cannot reach is not even asked
  for its model list. Its usage is its own: the rows it wrote (for what it may still name), and
  a summary whose `keys` holds its own fingerprint only — never another key's requests, not even
  for a model both may name.
- Every usage row says which key it came with and what the scope decided:
  `"key": "fp:3f9a0c12"`, `"scope": "unscoped" | "allowed" | "denied"`, and `"skipped": […]` for
  alias legs it left out. Opened by an unscoped key, the status page lists every key by
  fingerprint, label and scope, with its requests and refusals of the last 24 h.
- It fails closed. An entry with a field keysmith does not know (`"alow"` would otherwise read
  as "no allow list"), a list that is not a list of patterns, or one key listed twice with two
  different scopes leaves that key reaching nothing — every request a 403 that says why — and
  `doctor`, `key list`, the gateway log and the status page name it. A key list whose entries
  are all unreadable opens nothing; it never turns into a keyless gateway.
- A pattern that names nothing configured — `"deny": ["Claude-API"]` written by hand, when the
  adapter is `claude-api` — is not an error (it may name an adapter you add later), but it keeps
  nothing out, so `serve`, `doctor`, `key list` and the status page (to an unscoped key) warn
  about it, with a hint when a configured name differs only in case or `_`/`-`.
- With `auth.enabled` false no key is asked for, so no scope applies: `key add`, `key scope` and
  `key list` say so.

From the command line, by fingerprint (a key on the command line is in shell history and `ps`):

```bash
keysmith key add ada --deny claude-api --out ~/.config/ada/keysmith.key   # a new key with a scope, in a new 0600 file
keysmith key add scout --allow agy,alias:argon     # comma-separated, or the flag repeated
keysmith key scope fp:3f9a0c12 --deny claude-api   # narrow a key that exists; --allow/--deny replace that list
keysmith key scope fp:3f9a0c12 --no-allow          # drop one list; --clear drops both (unscoped again)
keysmith key scope fp:3f9a0c12                     # show it
keysmith key list                                  # each key redacted, with its label and its scope
keysmith key who-can claude-api                    # the fingerprints that reach an adapter, and the ones kept out
keysmith key who-can alias:argon                   # …or an alias, or one adapter/model
```

`key add` prints the new key the way it always has: in full only with `--reveal`, to an
interactive terminal (with its fingerprint, which `key scope` and `key revoke` take). `--out
<file>` writes it to a new file, mode 0600, for an agent to read (`{file:…}` in its config, or
`KEY=$(cat …)`). An existing file is not overwritten (`--force` replaces it), and when the file
cannot be written no key is added. A pattern that names no configured adapter or alias is
refused, because a deny-list typo keeps nothing out; `--allow-unknown` saves it anyway (for an
adapter you are about to add). `--force` does not: a script that rotates an agent's key into
the same file passes `--force` every time. Quote a glob, or the shell expands it.
`key add` with neither a label nor a scope still writes a bare key. Like every key change, a
scope takes effect when the gateway restarts, and `who-can` warns when the running gateway is
older than the config.

`explicitOnly` and a scope answer different questions: `explicitOnly` keeps an adapter out of
aliases for every key; a scope keeps one key away from an adapter however it asks for it.

### Recipe: an agent key that cannot reach claude-api

Say `claude-api` is an Anthropic HTTP adapter that spends a credit you use on purpose. An agent
that gets a key of its own must not be able to spend it — not by naming it, and not through an
alias that has, or later gains, a `claude-api` leg.

A scope binds only an agent that cannot read keysmith's config. The config is `0600` and its
owner's; an agent that runs as the same OS user, with a shell, reads the unscoped key out of it
the way the scripts above do (`KEY=$(jq …)`) and reaches `claude-api` with that.
Run the agent as another OS user, in a sandbox, or in CI given its own key and nothing else — the
`--out` file, or a secret holding it — and keep every unscoped key where the agent cannot read it.

```bash
keysmith key add ada --deny claude-api --out ~/.config/ada/keysmith.key
keysmith key who-can claude-api                          # ada's fingerprint is under "not reachable by"
launchctl kickstart -k gui/$UID/dev.keysmith.gateway     # or: keysmith stop && keysmith start
```

The agent reads its key from that file. Asked for `claude-api/…` it gets a 403 that names
`claude-api`; asked for an alias whose first leg is `claude-api`, it is answered by the next leg,
and its usage row says `"skipped": ["claude-api/…"]`; `/v1/models` does not list `claude-api`
for it. For an agent that should reach only routes you name, use an allow-list instead, where an
adapter added later stays out until you add it to the list:

```bash
keysmith key add ada --allow agy,alias:argon --out ~/.config/ada/keysmith.key
```

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

On macOS, `keysmith install-service` writes two LaunchAgents
(`~/Library/LaunchAgents/dev.keysmith.{gateway,tunnel}.plist`) so the gateway — and
the named tunnel, when configured — come back at login without a terminal. It embeds
absolute, symlink-resolved binary paths (an fnm multishell path dies with the shell
that minted it) and a PATH that can find your CLIs, stops the foreground `keysmith
start` / `tunnel run` processes it is replacing, and lets launchd's throttled retry
rebind the port. `keysmith uninstall-service` reverses it. Quick tunnels are not
persisted: a random hostname that changes every start earns nothing from a service.

The gateway agent is `ProcessType: Interactive`. Without it launchd runs the gateway, and
every CLI the gateway spawns, at utility priority with throttled I/O; on a busy machine
that tripled the wait for an agent's first token (9–30 s against 4–5 s, same code). An
agent installed by an older keysmith keeps its old plist — run `keysmith install-service`
again to rewrite it.

## Built-in profiles

| Profile | Kind | Status |
|---|---|---|
| `cmd` | cli | verified live against Command Code 1.66.0 — **`unsafeTools`**: a `-p` run approves its own tool calls, so it ships disabled, see [above](#agents-that-could-act-on-this-machine) |
| `opencode` | cli | verified live against opencode 1.18.27; tool-less agent checked against a stub endpoint (no `--auto`); its free `opencode/*` models refuse the tool-less run (403) |
| `qoder` | cli | verified with `-p`; its `-o json/stream-json` modes fail inside a nested agent session; tool-less flags parsed by 1.1.59 |
| `claude` | cli | tool-less flags and stream-json shape checked against Claude Code 2.1.261; no live request; explicit-only as shipped |
| `agy` | cli | verified live against Antigravity CLI 1.3.3 — your Google login, no key; runs as a tool-less text agent (~600-token prompt instead of ~20k), see [docs/adapters.md](docs/adapters.md#agy-as-a-plain-text-model); answers tool requests too (`toolMode: "auto"`: the MCP bridge, EMULATE where the bridge cannot — see [docs/adapters.md](docs/adapters.md#agy-and-tool-requests-the-mcp-bridge)) |
| `kiro` | cli | Kiro CLI 2.27.1 — tool-less agent, `stream-json`, model list as JSON; the first live run was refused for quota before any text, see [docs/adapters.md](docs/adapters.md#kiro-as-a-plain-text-model) |
| `codex` | cli | argv run against a stub Responses endpoint with codex 0.163.0 (read-only, no shell, no web search); gpt-6-* keep sub-agent tools; no request reached OpenAI |
| `warp` | cli | Warp's `oz` agent CLI, ndjson verified live — **`unsafeTools`**: ships disabled, never an alias leg, see [above](#agents-that-could-act-on-this-machine) |
| `gemini` | cli | documented argv shape, not run against a live install — **`unsafeTools`** until a tool-less argv is checked: ships disabled |
| `openai`, `anthropic`, `openrouter`, `groq`, `deepseek`, `together` | http | standard endpoints |
| `google` | http | verified live against Gemini's OpenAI-compatible endpoint: tools, streaming, thought signatures — see [above](#gemini-with-tools-the-google-profile) |
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
npm test          # 313 tests: parsers, routing, key scopes, tool routing and EMULATE, HTTP suites against stub CLIs and stub upstreams, and no key reaching a log
node src/cli.js doctor --probe-models   # the truth about which models answer (spends quota)
```

The integration suite spawns a stub script that prints Command-Code-shaped NDJSON, so
spawning, parsing, SSE framing, session mapping and failover are covered without
touching a provider or spending a token.

Config: `~/.config/keysmith/config.json` (`$KEYSMITH_CONFIG`).
State: `~/.local/share/keysmith/` (`$KEYSMITH_DATA`, `0700`) — pid, logs, `usage.jsonl`, all `0600`;
see [what is logged](#the-gateway-key-and-what-is-logged).

## License

MIT — see [LICENSE](LICENSE).
