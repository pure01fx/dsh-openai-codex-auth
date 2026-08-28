# Changelog

## 0.6.0

### Native Codex transport

- Adds package-owned ChatGPT Codex Responses HTTP/SSE and WebSocket v2 transports for DSH 0.1.0-rc.6.
- Supports text, tools, images, reasoning effort, usage, cancellation, bounded retries, replay state, stable routing identity, prewarm, incremental suffixes, reconnect, and safe pre-output HTTP fallback.
- Exposes capability-gated `<base>-fast` aliases while sending the base wire model with `service_tier: priority`; unsupported Fast requests fail without downgrade.

### Route migration

- When `nativeAdapter` is enabled, the native adapter atomically owns `openai-codex` and, by default, the compatibility route `openai-codex-native`.
- Ships `profiles/native-codex-hu`, pinned to the current Hu collection 0.1.1 composition, for a reversible cutover without modifying that collection.
- Existing rc.6 pi-ai replay degrades to durable visible history when a production session first continues on the native adapter.
- Reverse rollback to pi-ai does not guarantee continuation of sessions that already contain native replay; start a new session or continue with the native profile.

### Security and packaging

- Keeps OAuth credentials and account authority host-side, validates credential-bearing endpoint authorities, bounds request/response/replay/WebSocket state, and refuses managed/external credential mismatches.
- Pins Host/runtime contracts to DSH rc.6 and includes synchronized JavaScript/declaration artifacts plus the complete profile template.
- Keeps the package name `@pure01fx/dsh-openai-codex-auth`; a rename is intentionally deferred.
