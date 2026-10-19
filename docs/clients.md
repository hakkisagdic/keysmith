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
the result back. Through a CLI leg with a `toolMode` (agy, EMULATE) the calls come back in the
same shape as from an HTTP upstream — keysmith runs none of them:

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
