# Changelog

## Unreleased

## 0.6.0

### Native Codex transport

- Adds package-owned ChatGPT Codex Responses HTTP/SSE and WebSocket v2 transports for DSH 0.1.0-rc.6.
- Supports text, tools, images, reasoning effort, usage, cancellation, bounded retries, replay state, stable routing identity, prewarm, incremental suffixes, reconnect, and safe pre-output HTTP fallback.
- Exposes capability-gated `<base>-fast` aliases while sending the base wire model with `service_tier: priority`; unsupported Fast requests fail without downgrade.
- Centralizes the tracked OpenAI Codex repository revision, release, and Catalog client version in one source; updates Catalog requests to the tracked release.
- Matches current Codex reasoning wire semantics by mapping Persistent to `disabled` and Ultra through model-aware fallbacks.

### Reliability and replay

- Keeps DSH subagent settlement histories usable by dropping relayed non-assistant reasoning and child-owned tool calls at the native adapter boundary while preserving surrounding text, strict validation for ordinary user messages, and assistant native replay.
- Waits through pure HTTP/WebSocket connection outages without consuming the five stream retries, using cancellable 5-second exponential delays capped at 60 seconds until the network recovers.
- Matches Codex's default five dropped-stream retries: WebSocket reconnects use bounded exponential backoff and provider delays, while retryable failures after visible output recover at DSH's durable failed-step boundary without promoting failed chunks into assistant history or duplicating the pre-output retry budget.

### Route migration

- Makes the native adapter the default owner of `openai-codex`; auth-only integrations may explicitly set `nativeAdapter: false`, while the legacy `openai-codex-native` route remains opt-in.
- Keeps profile-specific provider removal and migration out of this package; integration bundles must release any existing `openai-codex` route before mounting it.
- Existing rc.6 pi-ai replay degrades to durable visible history when a production session first continues on the native adapter.
- Reverse rollback to pi-ai does not guarantee continuation of sessions that already contain native replay; start a new session or continue with a native-enabled integration.
- Shows the Host-observed `openai-codex` route state in the settings UI, including Native transport mode, external ownership, compatibility-route activity, and unregistered failures without guessing an external adapter identity.

### Usage and Web UI

- Preserves exact `response.completed.usage_metadata.amount` strings across HTTP/SSE and WebSocket and exposes the latest account-scoped observation in status.
- Parses bounded subscription quota updates directly from WebSocket `codex.rate_limits` events and HTTP/wrapped-WebSocket `x-codex-*` headers, updates the settings card immediately, and skips the redundant turn-end `wham/usage` request while retaining explicit and missing-update fallback refreshes.
- Hides incomplete weekly quota placeholders when they report 0% usage without a reset timestamp, in both the conversation quota panel and settings card.
- Shows the conversation quota panel on hover or keyboard focus and reserves clicking the quota ring for an explicit refresh.
- Adds browser-local Codex model visibility checkboxes that immediately filter the model selector without changing Host routing or existing sessions.

### Security and packaging

- Rejects redirects for credential-bearing OAuth, Catalog, Responses, and subscription-usage requests.
- Keeps OAuth credentials and account authority host-side, validates credential-bearing endpoint authorities, bounds request/response/replay/WebSocket state, and refuses managed/external credential mismatches.
- Pins Host/runtime contracts to DSH rc.6 and includes synchronized JavaScript/declaration artifacts plus the complete native transport modules.
- Keeps the package name `@pure01fx/dsh-openai-codex-auth`; a rename is intentionally deferred.
