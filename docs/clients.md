# Client recipes

Everything below points a client at a keysmith gateway. Local:

```
base URL          http://127.0.0.1:8787/v1
API key           keysmith key list --reveal # the ks_… value — in full only to an interactive terminal
model id          keysmith models            # <adapter>/<model>, or an alias
```

Behind a named tunnel the base URL is `https://llm.example.com/v1` and the key is the
only thing standing between the internet and your agent's quota — see
[tunnel.md](tunnel.md).

An agent is better off with a key of its own, with a scope, written to a file it reads:
`keysmith key add <label> --deny claude-api --out <file>` (or `--allow agy,alias:argon`). It sees
only the models that key may reach, and a request outside them is a 403 naming the adapter — see
"Keys with a scope" in the [README](../README.md#keys-with-a-scope-what-each-key-may-reach). The
scope binds only an agent that cannot read keysmith's config: one running as the same OS user,
with a shell, can read the unscoped key there. Give it its own OS user, a sandbox, or a CI job that
holds its key and nothing else.

---

## Warp (Bring-your-own-key / custom endpoint)

Warp keeps endpoint definitions in **two places that must agree**, so edit both:

1. `~/.warp/settings.toml`

```toml
[agents.custom_endpoints.legacy-074f5d395bd0a9dd001cc6bf]
base_url = "http://127.0.0.1:8787/v1"
schema = "openai_chat_completions"

[[agents.custom_endpoints.legacy-074f5d395bd0a9dd001cc6bf.models]]
id = "cmd/gpt-5"
alias = "cmd/gpt-5"
name = "Command Code GPT-5"
config_key = "11111111-1111-1111-1111-111111111111"

[[agents.custom_endpoints.legacy-074f5d395bd0a9dd001cc6bf.models]]
id = "cheap"
alias = "cheap"
name = "Cheapest route"
config_key = "22222222-2222-2222-2222-222222222222"
```

2. macOS Keychain, `svc=dev.warp.Warp-Stable`, account `AiApiKeys` — a JSON blob with
   `.custom_endpoints[]` entries of `{url, api_key, models:[{config_key,…}]}`, plus
   account `AiCustomEndpointKeys` mapping `legacy-<id>` → the key.

Rules learned the hard way:

- **Quit Warp first.** The binary is `MacOS/stable`, so `pgrep -x Warp` never matches —
  use `osascript -e 'tell application "Warp" to quit'`. Warp rewrites the file on exit
  and keeps only what it can parse.
- `settings.toml` is **not strict TOML** (multi-line inline tables). `tomllib` rejects it
  even when Warp is happy; normalise `{ \n … \n }` → `{ … }` before validating it in a
  script, and don't "fix" Warp's formatting.
- `[agents.execution_profiles.default].base_model` holds a model `config_key` UUID. If
  you delete the endpoint that owns it, the default profile goes dangling and the
  picker looks broken.
- An endpoint whose host vanishes does not error politely: it just stops answering. That
  is the argument for a **named** tunnel over a quick tunnel — a
  `trycloudflare.com` hostname dies with the process and every client entry pointing at
  it silently goes dead.
- Warp is on `openai_chat_completions`, which is exactly the face keysmith serves, so
  use an alias as the model id and let failover happen server-side.

## Claude Code / anything speaking the Anthropic Messages API

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787      # no /v1 — it appends /v1/messages
export ANTHROPIC_API_KEY="$KEYSMITH_KEY"             # or ANTHROPIC_AUTH_TOKEN
claude -p "summarise this repo in three lines"
```

keysmith's `/v1/messages` is a real Messages-shaped surface (SSE `message_start` …
`message_stop`), so the CLI is happy. Note what you lose: the CLI will send its own tool
definitions, and a **CLI** adapter cannot hand `tool_calls` back — point these clients at
an HTTP adapter or an alias whose first leg is HTTP.

For a gateway on the Anthropic wire, the adapter itself needs `"wire": "anthropic"`;
clients never see that, they only see keysmith's own face.

One Anthropic-specific trap: `max_tokens` is mandatory there, and a reasoning model spends
it on thinking before it writes a word. Measured against a live upstream, `"max_tokens":
32` on a one-word answer came back truncated to `"ANTH"` with `output_tokens: 32` — the
bridge was not cutting anything off, the budget was gone. Give thinking models at least a
couple of hundred.

## Command Code

Command Code keeps the URL and the key in **separate files**, and refuses a raw secret in
the provider entry:

```jsonc
// ~/.commandcode/providers.json
{ "provider": { "keysmith": {
  "name": "keysmith", "api": "openai", "baseURL": "http://127.0.0.1:8787/v1",
  "models": { "cmd/gpt-5": {}, "cheap": {} }
} } }
```

```jsonc
// ~/.commandcode/auth.json   — written by /connect, top-level key = provider id
{ "keysmith": { "type": "api", "key": "ks_…" } }
```

Verify with `cmd --list-models` (a broken entry prints a targeted warning instead of
dying) and `cmd -p --trust -m keysmith/cheap "say hi"`.

Recursive by design: a `cmd` adapter inside a keysmith gateway, consumed by `cmd`
itself, works — just keep the alias's first leg HTTP or you will pay the 16k-token agent
prompt twice. `limits.maxConcurrent` is the brake that stops that from becoming a fork
bomb; a `timeoutMs` is what kills a wedged generation.

## opencode (and Traycer, which shares its store)

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "provider": {
    "keysmith": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "keysmith",
      "options": { "baseURL": "http://127.0.0.1:8787/v1", "headers": { "Authorization": "Bearer ks_…" } },
      "models": { "cmd/gpt-5": { "limit": { "context": 200000, "output": 8192 } }, "cheap": {} }
    }
  },
  "model": "keysmith/cheap"
}
```

`~/.local/share/opencode/auth.json` is the other option (and the form keysmith itself
reads as a `{json:…#…}` secret reference). Both the standalone CLI and Traycer's managed
`opencode serve` read this one store; Traycer only needs the launch arg
(`~/.traycer/host/config/provider-overrides.json` → `"opencode.terminalAgentArgs":
"--model keysmith/cheap"`). A running `opencode serve` keeps the old model list until it
restarts.

## Codex CLI (the Responses face)

```toml
# ~/.codex/config.toml
[model_providers.keysmith]
name = "keysmith"
base_url = "http://127.0.0.1:8787/v1"
env_key = "KEYSMITH_KEY"
wire_api = "responses"
```

`/v1/responses` accepts the `input` array form and answers with `output[]` items. If a
client needs SSE `event:` names, they are there (`response.output_text.delta`,
`response.completed`).

Function tools work on this face too, on a route with a CLI leg that has a `toolMode` (agy,
opencode, codex, qoder as shipped): a call comes back as a `function_call` output item, and
the client's next request carries it and its `function_call_output` in `input`. A request
with a tool no CLI leg can honour — a freeform one (`"type": "custom"`, such as Codex's own
`apply_patch`) or a hosted one (`web_search`, …) — is a 400 that names it: a CLI route takes
function tools only. Codex as a client sends tools of its own, `apply_patch` among them in the
versions the design probed, so it is not a client of this path as it stands. keysmith stores
no response, so the loop keeps its own history, as below: a request that names
`previous_response_id` (the SDK's other tool loop), a `conversation` or an `item_reference`, or
that sends a `function_call_output` without its `function_call`, is a 400 that says so — with
tools or without. With the openai SDK:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=KEYSMITH_KEY)
tools = [{"type": "function", "name": "get_weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]
history = [{"role": "user", "content": "Weather in Ankara?"}]
r = client.responses.create(model="agy/gemini-4-argon-high", input=history, tools=tools, store=False)
for item in r.output:
    history.append(item)
    if item.type == "function_call":
        history.append({"type": "function_call_output", "call_id": item.call_id, "output": "sunny, 21 C"})
r = client.responses.create(model="agy/gemini-4-argon-high", input=history, tools=tools, store=False)
print(r.output_text)
```

## Qoder

`~/.qoder/settings.json` → `providers`, with `$KEYSMITH_KEY`-style env references
supported for `apiKey` — but the desktop app launched from the Dock inherits no shell
env, so put the literal (the file is `0600`). Omit `capabilities.thinking` for an
OpenAI-compatible gateway: an unrecognised thinking shape makes Qoder **silently drop
that model** from the picker with no warning. `requiresRestart: true` means quit and
relaunch the desktop app.

## From code: the `openai` SDK

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="ks_…")

r = c.chat.completions.create(model="cheap", messages=[{"role": "user", "content": "hi"}])
print(r.choices[0].message.content, r.usage.prompt_tokens)

for chunk in c.chat.completions.create(model="cmd/gpt-5", stream=True,
                                       messages=[{"role": "user", "content": "a haiku"}]):
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

`keysmith.models.list()` is what the CLI's `models` command calls; `?refresh=1` re-queries
the upstreams instead of using the 10-minute cache.

Tools work the way they do against OpenAI: the model asks, your code runs the tool and sends
the result back. Through a CLI leg with a `toolMode` (agy: the MCP bridge, or EMULATE) the calls
come back in the same shape as from an HTTP upstream — keysmith runs none of them:

```python
import json
tools = [{"type": "function", "function": {
    "name": "get_weather", "description": "Current weather for a city",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]
messages = [{"role": "user", "content": "Weather in Ankara?"}]

r = c.chat.completions.create(model="agy/gemini-4-argon-high", messages=messages, tools=tools)
msg = r.choices[0].message                     # finish_reason "tool_calls"
messages.append(msg)
for call in msg.tool_calls:                    # ids are keysmith's: call_<24 hex>
    args = json.loads(call.function.arguments)
    messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps({"temp": 21})})
r = c.chat.completions.create(model="agy/gemini-4-argon-high", messages=messages, tools=tools)
print(r.choices[0].message.content)
```

LangChain's `ChatOpenAI(base_url="http://127.0.0.1:8787/v1", api_key="ks_…",
model="agy/gemini-4-argon-high").bind_tools([...])` reads them the same way, streamed or not.

On agy's MCP bridge (its default for a tool request) the agy process that made the call waits
for its result, so the loop above is all a client does — with three things to know. A turn
holds one call, even with `parallel_tool_calls`: agy runs the calls of one step one after
another, so a step of three is three round trips. The result goes straight back into the waiting
process when it comes within `toolResultTimeoutMs` (5 minutes), with the same key and the history
as keysmith answered it, and nothing after it; a later result, an edited history, another key,
or text of your own after the result (a `text` block next to the `tool_result` on
`/v1/messages`, a user message after the `tool` message) still gets an answer, on a new agy run
that reads the conversation so far (slower, and it spends the whole transcript again). And one
result goes in once: two requests carrying it at the same time get one answer and one 409. The
response's `x-keysmith-mode` says `mcp` or `emulate`; both answer in the same shape. A client
that still sends the older `functions` and reads `function_call` gets its answers from EMULATE
on every turn: those calls carry no id a later request could continue a session by.
An EMULATE turn on Argon takes tens of seconds; a streamed one sends keepalive comments until
the calls are ready, so leave the client's read timeout at its default (600 s for the
`openai` SDK) or above. A reply the model got wrong twice is an error whose type is
`tool_emulation_error`. Not streamed — or streamed, when it comes inside `limits.streamHoldMs`
(10 s) — it is an HTTP 502: retry it like any 5xx. A streamed turn that takes longer has
already opened its stream (`: stream open`, keepalives), so the error is the stream's last
frame — `data: {"error":{…,"type":"tool_emulation_error"}}`, then `data: [DONE]` (an `error`
event on `/v1/messages`). The `openai` SDK raises that in the middle of the iteration as an
`APIError` with no `status_code`, and does not retry it: catch it around the loop and send the
request again if you want the retry.

## Unknown usage on the wire

A CLI does not always say what an answer spent: codex and qoder report a run's tokens once, when
the run ends, so on the MCP bridge the answer that hands a call out has none yet; `raw` and
`warp-ndjson` runs report none at all. Such an answer's `usage` object says so in two fields of
keysmith's own, which every SDK ignores:

```
"keysmith_usage": "unknown"                          only on an answer with no counts
"reason": "cx reports a run's tokens once, when the run ends: …"
```

and each count in it is **null where the clients' parsers take null, 0 only where one of them
requires a number**. A 0 next to `keysmith_usage` is no count. The parsers that decide it are
the Vercel AI SDK's (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`): they
check every chunk against a schema and end the run on one that fails it (CopilotKit's OpenBot
stopped at its first tool turn on a null `output_tokens`). The official `anthropic` and `openai`
SDKs read usage without checking it.

| Face | 0 (a number is required) | null |
|---|---|---|
| `/v1/chat/completions` | — | `prompt_tokens`, `completion_tokens`, `total_tokens`, `cached_tokens`, `reasoning_tokens` |
| `/v1/messages`, a whole Message (not streamed) | `input_tokens`, `output_tokens` | `cache_creation_input_tokens`, `cache_read_input_tokens` |
| `/v1/messages`, `message_delta` (streamed) | `output_tokens` | `input_tokens` (message_start said 0), the cache's two counts |
| `/v1/responses`, a Response and `response.completed` | `input_tokens`, `output_tokens`, `total_tokens` | `cached_tokens`, `reasoning_tokens` |

So an AI SDK app adds 0 for such a turn to its totals, and the answer that ends the session
carries the whole run. `@ai-sdk/anthropic` keeps the usage object whole in
`providerMetadata.anthropic.usage`, marker and reason included; the OpenAI providers keep the
counts only. The usage log is no wire: its row is `usage: null` with a `usageReason`, never a 0
([adapters.md](adapters.md#parsers-and-the-event-contract)). Checked with ai 6.0.264 (`@ai-sdk/anthropic` 3.0.111,
`@ai-sdk/openai` 3.0.99: what OpenBot runs), ai 7.0.162 (`@ai-sdk/anthropic` 4.0.96,
`@ai-sdk/openai` 4.0.108, `@ai-sdk/openai-compatible` 3.0.84), `@anthropic-ai/sdk` 1.4.0 and
`openai` 7.5.0 / 7.50.0 — `test/wire-conformance.test.js` runs each of them against a stub
gateway (`npm ci` first: they are pinned devDependencies).

## curl

```bash
KEY=$(jq -r '.auth.keys[0]' ~/.config/keysmith/config.json)   # piped, `keysmith key list` prints only ks_Q…35 fp:…
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"cheap","messages":[{"role":"user","content":"one line, no preamble"}]}'

# continue a CLI thread: send the session id back
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "x-keysmith-session: kss_…" -H 'content-type: application/json' \
  -d '{"model":"cmd/gpt-5","messages":[{"role":"user","content":"and now in Turkish"}]}'
```

`?api_key=$KEY` works on `/v1` too, for clients that cannot set a header — but it puts the
key in shell history, browser history and a tunnel's request logs, so prefer the header.
The status page at `/` does not take it at all: open it and post the key through its form.
