# Changelog

## [Unreleased]

### Security
- Reload `auth.keys` on `SIGHUP` (so `SIGHUP` now reloads keys and no longer stops the gateway on terminal hang-up) and `config.json` `mtime` changes (recording reload state only after valid JSON parse, logging a failed reload once per file stamp, refusing to disable auth on reload when a named or quick tunnel or non-loopback host is active, and writing `config.json` atomically via temp+rename), signal a running `keysmith serve` instance whose pidfile matches `config.json` from `key add`/`key revoke`/`key scope`, and print the restart hint only when no signal was delivered (M1).
- Re-check caller key scope against the resolved base model after effort-suffix stripping and filter effort-suffixed entries on `/v1/models` (M2).
- Namespace the CLI session map by caller fingerprint plus session ID so sessions cannot be resumed across keys (M3).
- Restrict tool-call HTTP relay upstream payloads (`relayLeg` and `HttpAdapter.rawChat`) to an explicit OpenAI chat field allow-list (including `prompt_cache_key`, `verbosity`, and `extra_body.google`, while dropping the rest of `extra_body`, `service_tier`, `metadata`, `store`, and router/override fields) (M4).
- Treat only literal `auth.enabled === false` as auth disabled, fail closed when `auth.keys` is empty, refuse to start with auth off when a tunnel is configured or host is non-loopback, and stop sending `access-control-allow-origin: *` (M5).
- Disable `?api_key=` on API routes by default and, when `auth.allowQueryApiKey` is enabled, accept it only from direct loopback clients without `cf-connecting-ip` or `x-forwarded-for` (M6).
- Normalise model case and `.` / empty path segments before matching scope patterns and warn in `key add`/`key scope --deny` when an exact-model deny is used (L1).
- Reserve realistic estimated spend (`promptChars / 4` input tokens plus requested or adapter max output tokens, and `0` output tokens for embeddings) for in-flight requests across all metered paths including the tool-call passthrough relay, and hold each reservation until its usage row is recorded (L2).
- Enforce `limits.maxConcurrent` globally in the HTTP server before `meter()` with `429 rate_limit_error` (so rejected requests do not consume `perDay` quota or write a usage row), raise the default to `32`, and treat an explicit `limits.maxConcurrent: 4` (written by older `keysmith init` and `examples/config.json`) as legacy `32` with a warning at startup and in `keysmith doctor` (L3).
- Redact `error.provider` on 403/404 responses and raw paths on 404 route errors, omit `baseUrl`/`bin` on `/v1/keysmith/routes` for scoped keys, and return only `{ ok: true }` on `/healthz` when `cf-connecting-ip` is present (L4).
- Load `config.json` with `{ mint: false }` in `key` subcommands so the first `key add` on an empty key list does not mint a hidden unscoped key (L5).
- Support SHA-256 `keyHash` entries in `config.json` and `--hash` on `key add`, mark hashed keys in `key list`, preserve identical caller IDs between plaintext and hashed keys, and document that hashed keys cannot be redacted by exact value if echoed by a client (L6).
