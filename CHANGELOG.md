# Changelog

## Unreleased

## 0.8.0

### Multi-account authentication

- Adds multiple managed ChatGPT OAuth accounts with a global current-account selector, per-account removal, optional email labels, and automatic activation of newly added accounts.
- Migrates legacy version-1 single-account credential documents atomically to version 2 while keeping DSH credential publication and rollback guarantees.
- Pins every request/recovery attempt to its starting account so a concurrent account switch cannot replay an authenticated request under another account.
- Extends the same-origin settings API and Web UI with an account list, explicit switching, and individual logout controls without exposing access or refresh tokens.

## 0.7.3

### Client model visibility

- Connects the settings-panel Codex visibility controls to DSH's shared model directory: opening either model selector now caches the loaded Codex catalog, updates an already-open settings section, and filters hidden models in the current browser.

### WebSocket reliability

- Keeps credential-backed WebSocket connection failures inside the bounded reconnect budget and falls back to HTTP/SSE, preventing turns from remaining on “Deep diving...” forever when a server can reach Codex over HTTPS but not WebSocket.
- Routes WebSocket v2 through the same opt-in `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY` / `HTTP_PROXY`, and `NO_PROXY` contract as Node fetch, using an HTTP CONNECT tunnel for WSS endpoints.

## 0.7.2

### Auxiliary-call compatibility

- Accepts DSH's purpose-tagged compaction and session-title `maxTokens` budgets without serializing an unsupported Native Codex output-cap field, while ordinary model calls continue to reject unsupported explicit caps.
- Restores automatic compaction for long Native Codex sessions that previously accumulated failed `compaction/end` events.

## 0.7.1

### Native stream compatibility

- Aligns long native Codex streams with codex-rs by removing aggregate event/wire-byte, output-item, and replay-item ceilings, using a 300-second WebSocket idle timeout, and retaining 64 MiB single-event/frame, queued-byte, translated-content, retained-output, and replay-state safeguards.

## 0.7.0

### DSH 0.1.1 compatibility

- Targets DeepSeek Harness `0.1.1-rc.2` across Host peers, runtime helpers, development contracts, and generated artifacts.
- Emits successful native continuation metadata through the rc.2 `ReplayEnvelope.response` contract while continuing to read legacy raw replay state from existing sessions.
- Removes the duplicate runtime dependency on `@deepseek-ai/dsh-credentials`, keeping the Host credentials service as a peer-owned singleton.

## 0.6.1

### WebSocket reliability

- Cancels image and attachment request preparation when the transport is disposed, preserving the `DISPOSED` lifecycle result before a WebSocket session becomes active.
- Stops same-stream reconnect and replay after any output has been emitted; retryable interruptions now cross the durable failed-step recovery boundary without duplicating visible chunks.
- Keeps credential-backed connection failures on the bounded reconnect and HTTP fallback path instead of treating every low-level network error as an indefinite pre-credential outage.

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
