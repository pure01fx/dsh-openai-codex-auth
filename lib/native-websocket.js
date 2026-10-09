/** WebSocket v2 Responses transport with bounded session state and sticky HTTP fallback. */
import { createHash } from 'node:crypto';
import { retryError, remainingRetryDelay, sleepRetry, jsonRetryAfterMs } from './retry-after.js';
import { networkTelemetry, trackNetwork, observeNetworkOutput } from './network-telemetry.js';
import { LlmError, ProviderRequestId, attributionHeaders, } from '@deepseek-ai/dsh-llm';
import { nativeCodexAuthorityHash } from './catalog.js';
import { NATIVE_CODEX_CONNECTION_FAILED_CODE, NATIVE_CODEX_STREAM_INTERRUPTED_CODE, isNativeCodexConnectionFailure, } from './native-adapter.js';
import { NativeCodexHttpTransport, } from './native-http.js';
import { replayableItemId } from './replay.js';
import { parseCodexResponseUsageMetadata, publishCodexResponseUsage, } from './response-usage.js';
import { parseCodexRateLimitEvent, parseCodexRateLimitHeaders, publishCodexRateLimits, } from './rate-limits.js';
import { ResponsesStreamTranslator, responsesFailure, codexResponseTurnState, } from './responses.js';
import { NodeNativeCodexWebSocketFactory, } from './native-websocket-socket.js';
import { NativeCodexWebSocketSessionState } from './native-websocket-session.js';
const WS_BETA = 'responses_websockets=2026-02-06';
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
const DEFAULT_MAX_RECONNECTS = 5;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 200;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
const INITIAL_CONNECTION_RETRY_DELAY_MS = 5_000;
const MAX_CONNECTION_RETRY_DELAY_MS = 60_000;
const MAX_TURN_STATE_BYTES = 4096;
function failure(message, code, cause) {
    return retryError(message, code, cause === undefined ? undefined : { cause });
}
function reconnectable(code) {
    return [
        'WS_RETRYABLE', 'WS_RETRYABLE_RESET', 'WS_PROTOCOL_ERROR',
        'TIMEOUT',
        NATIVE_CODEX_CONNECTION_FAILED_CODE,
    ].includes(code);
}
function failedStepRetryable(code) {
    return ['WS_RETRYABLE', 'WS_RETRYABLE_RESET', 'TIMEOUT'].includes(code);
}
function failedStepRetry(error) {
    const facts = error.failure;
    const providerRetryAfterMs = facts.providerRetryAfterMs;
    return retryError(`native Codex response stream was interrupted: ${error.message}`, NATIVE_CODEX_STREAM_INTERRUPTED_CODE, {
        cause: error,
        ...(facts.status === undefined ? {} : { status: facts.status }),
        ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
        ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
    });
}
function positive(value, fallback, label) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw failure(`native Codex ${label} is invalid`, 'INVALID_ARGS');
    }
    return resolved;
}
function boundedPositive(value, fallback, maximum, label) {
    const resolved = positive(value, fallback, label);
    if (resolved > maximum)
        throw failure(`native Codex ${label} exceeds its maximum`, 'INVALID_ARGS');
    return resolved;
}
function retryCount(value) {
    const resolved = value ?? DEFAULT_MAX_RECONNECTS;
    if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 100) {
        throw failure('native Codex WebSocket reconnect count is invalid', 'INVALID_ARGS');
    }
    return resolved;
}
function socketCredential(credential) {
    return createHash('sha256')
        .update(credential.accountId).update('\0').update(credential.accessToken)
        .digest('base64url');
}
function sessionKey(generation, routingId) {
    if (generation.sessionId === undefined)
        return undefined;
    return createHash('sha256').update(routingId).digest('base64url');
}
function turnKey(generation) {
    for (let index = generation.messages.length - 1; index >= 0; index--) {
        const message = generation.messages[index];
        // RequestUserInput doesn't have source or id
        if (message && 'source' in message && message.source?.kind === 'user' && 'id' in message) {
            return createHash('sha256').update(String(message.id)).digest('base64url');
        }
    }
    return createHash('sha256')
        .update(`${generation.purpose ?? 'ordinary'}:handbuilt`).digest('base64url');
}
function withRequestMetadata(request, turnState, responsesLite) {
    if (turnState === undefined && !responsesLite)
        return request;
    const metadata = typeof request.client_metadata === 'object'
        && request.client_metadata !== null && !Array.isArray(request.client_metadata)
        ? request.client_metadata
        : {};
    return {
        ...request,
        client_metadata: {
            ...metadata,
            ...(turnState === undefined ? {} : { 'x-codex-turn-state': turnState }),
            ...(responsesLite
                ? { ws_request_header_x_openai_internal_codex_responses_lite: 'true' } : {}),
        },
    };
}
function normalizedOutputItem(event, translator) {
    if (event.type !== 'response.output_item.done' || event.item === undefined)
        return undefined;
    const item = event.item;
    const id = replayableItemId(item.id);
    if (item.type === 'message') {
        const phase = item.id === undefined ? undefined : translator.messagePhase(item.id);
        return {
            type: 'message', ...(id === undefined ? {} : { id }), role: 'assistant',
            content: (item.content ?? []).map(part => ({ type: 'output_text', text: part.text })),
            ...(phase === undefined ? {} : { phase }),
        };
    }
    if (item.type === 'reasoning') {
        return {
            type: 'reasoning', ...(id === undefined ? {} : { id }),
            summary: item.summary ?? [],
            ...typeof item.encrypted_content === 'string'
                ? { encrypted_content: item.encrypted_content } : {},
        };
    }
    if (item.type === 'function_call') {
        return {
            type: 'function_call', ...(id === undefined ? {} : { id }),
            ...(typeof item.namespace === 'string' ? { namespace: item.namespace } : {}),
            call_id: item.call_id, name: item.name, arguments: item.arguments,
        };
    }
    return undefined;
}
function eventHeader(event, name) {
    if (typeof event.headers !== 'object' || event.headers === null)
        return undefined;
    for (const [key, raw] of Object.entries(event.headers)) {
        if (key.toLowerCase() !== name)
            continue;
        const value = Array.isArray(raw) ? raw[0] : raw;
        return typeof value === 'string' ? value : undefined;
    }
    return undefined;
}
function eventErrorFacts(event, status) {
    const requestId = eventHeader(event, 'x-request-id');
    const nested = typeof event.error === 'object' && event.error !== null
        ? event.error : undefined;
    const retryMs = jsonRetryAfterMs(nested?.headers) ?? jsonRetryAfterMs(event.headers);
    return {
        ...(status === undefined ? {} : { status }),
        ...(retryMs === undefined ? {} : { providerRetryAfterMs: retryMs }),
        ...(requestId === undefined || requestId.length === 0 || requestId.length > 256
            ? {} : { requestId: ProviderRequestId(requestId) }),
    };
}
function eventFailure(event) {
    if (event.type !== 'error')
        return undefined;
    const error = typeof event.error === 'object' && event.error !== null
        ? event.error : event;
    const providerCode = typeof error.code === 'string' ? error.code : undefined;
    const rawStatus = event.status ?? event.status_code ?? error.status ?? error.status_code;
    const status = typeof rawStatus === 'number' && Number.isSafeInteger(rawStatus)
        ? rawStatus : undefined;
    const facts = eventErrorFacts(event, status);
    if (providerCode === 'websocket_connection_limit_reached'
        || providerCode === 'previous_response_not_found') {
        return retryError('native Codex WebSocket requested a fresh connection', 'WS_RETRYABLE_RESET', facts);
    }
    if (providerCode === 'unauthorized' || providerCode === 'invalid_api_key' || status === 401) {
        return retryError('native Codex WebSocket authentication failed', 'WS_AUTH', facts);
    }
    if (status === 403)
        return retryError('native Codex WebSocket authorization failed', 'AUTH', facts);
    const classified = responsesFailure(providerCode, typeof error.message === 'string' ? error.message : undefined);
    if (classified.code !== 'SERVER') {
        const delay = facts?.providerRetryAfterMs ?? classified.failure.providerRetryAfterMs;
        return retryError(classified.message, classified.code === 'RATE_LIMIT' ? 'RATE_LIMITED' : classified.code, {
            ...facts,
            ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        });
    }
    if (providerCode === 'usage_limit_reached' || status === 429) {
        return retryError('native Codex WebSocket rate limit was reached', 'RATE_LIMITED', facts);
    }
    if (status !== undefined && status >= 500) {
        return retryError('native Codex WebSocket service failed', 'WS_RETRYABLE', facts);
    }
    return retryError('native Codex WebSocket request was rejected', 'INVALID_REQUEST', facts);
}
/**
 * One bounded log line naming the provider's own rejection, so an operator can
 * see why the socket refused a request. The provider's free-form text stays in
 * the log; it never becomes the provider-neutral error message.
 */
function rejectionDiagnostic(event) {
    const error = typeof event.error === 'object' && event.error !== null
        ? event.error : event;
    const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined;
    const raw = typeof error.message === 'string' ? error.message : '';
    const message = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
    const status = typeof event.status === 'number' ? ` status=${String(event.status)}` : '';
    const detail = [code, message.length === 0 ? undefined : message]
        .filter((part) => part !== undefined).join(': ');
    return `native Codex WebSocket rejected the request${status}${detail.length === 0 ? '' : ` (${detail})`}`;
}
/** Prefer WebSocket v2; once safe retries exhaust, keep that DSH session on HTTP. */
export class NativeCodexWebSocketTransport {
    options;
    http;
    factory;
    sessions = new Map();
    connectTimeoutMs;
    idleTimeoutMs;
    maxSessions;
    sessionIdleMs;
    maxReconnects;
    initialRetryDelayMs;
    maxRetryDelayMs;
    preparing = new Set();
    active = new Map();
    disposed = false;
    constructor(options) {
        this.options = options;
        this.http = new NativeCodexHttpTransport(options);
        this.factory = options.webSocketFactory ?? new NodeNativeCodexWebSocketFactory();
        this.connectTimeoutMs = boundedPositive(options.webSocketConnectTimeoutMs, 10_000, 120_000, 'WebSocket connect timeout');
        this.idleTimeoutMs = boundedPositive(options.webSocketIdleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 60 * 60_000, 'WebSocket idle timeout');
        this.maxSessions = boundedPositive(options.maxWebSocketSessions, DEFAULT_MAX_SESSIONS, 256, 'WebSocket session limit');
        this.sessionIdleMs = boundedPositive(options.webSocketSessionIdleMs, DEFAULT_SESSION_IDLE_MS, 24 * 60 * 60_000, 'WebSocket session idle limit');
        this.maxReconnects = retryCount(options.maxWebSocketReconnects);
        this.initialRetryDelayMs = boundedPositive(options.initialRetryDelayMs, DEFAULT_INITIAL_RETRY_DELAY_MS, 120_000, 'WebSocket initial retry delay');
        this.maxRetryDelayMs = boundedPositive(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS, 120_000, 'WebSocket maximum retry delay');
    }
    retryDelay(retry, error) {
        const providerDelay = remainingRetryDelay(error);
        if (providerDelay !== undefined)
            return providerDelay;
        const exponential = Math.min(this.initialRetryDelayMs * (2 ** retry), this.maxRetryDelayMs);
        const random = this.options.random?.() ?? Math.random();
        const jitter = 0.9 + Math.max(0, Math.min(1, random)) * 0.2;
        return Math.max(1, Math.round(exponential * jitter));
    }
    async wait(retry, error, signal, telemetry) {
        const delay = this.retryDelay(retry, error);
        telemetry.retry(delay);
        await (this.options.sleep ?? sleepRetry)(delay, signal);
    }
    async waitForConnection(delayMs, signal, telemetry) {
        telemetry.retry(delayMs, 'connection');
        this.options.warn?.(`native Codex network is unavailable; reconnecting in ${delayMs}ms`);
        await (this.options.sleep ?? sleepRetry)(delayMs, signal);
    }
    closeEntry(entry) {
        entry.socket?.close();
        entry.socket = undefined;
        entry.socketCredential = undefined;
        entry.protocol.reset();
    }
    prune(now) {
        for (const [key, entry] of this.sessions) {
            if (!entry.busy && now - entry.lastUsed > this.sessionIdleMs) {
                this.closeEntry(entry);
                this.sessions.delete(key);
            }
        }
        while (this.sessions.size >= this.maxSessions) {
            const oldest = [...this.sessions].filter(([, entry]) => !entry.busy)
                .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
            if (oldest === undefined)
                break;
            this.closeEntry(oldest[1]);
            this.sessions.delete(oldest[0]);
        }
    }
    entry(key) {
        const now = Date.now();
        if (key === undefined)
            return {
                socket: undefined, socketCredential: undefined,
                protocol: new NativeCodexWebSocketSessionState(),
                disabled: false, prewarmAttempted: false, prewarmSucceeded: false, busy: false,
                turnKey: undefined, turnState: undefined, lastUsed: now, pooled: false,
            };
        const existing = this.sessions.get(key);
        if (existing !== undefined && (existing.busy || now - existing.lastUsed <= this.sessionIdleMs)) {
            return existing;
        }
        if (existing !== undefined) {
            this.closeEntry(existing);
            this.sessions.delete(key);
        }
        this.prune(now);
        if (this.sessions.size >= this.maxSessions) {
            return {
                socket: undefined, socketCredential: undefined,
                protocol: new NativeCodexWebSocketSessionState(),
                disabled: false, prewarmAttempted: false, prewarmSucceeded: false, busy: false,
                turnKey: undefined, turnState: undefined, lastUsed: now, pooled: false,
            };
        }
        const created = {
            socket: undefined, socketCredential: undefined,
            protocol: new NativeCodexWebSocketSessionState(),
            disabled: false, prewarmAttempted: false, prewarmSucceeded: false, busy: false,
            turnKey: undefined, turnState: undefined, lastUsed: now, pooled: true,
        };
        this.sessions.set(key, created);
        return created;
    }
    assertFastAuthority(credential, mode) {
        if (mode.serviceTier !== undefined
            && (mode.authorityHash === undefined
                || nativeCodexAuthorityHash(credential.accountId) !== mode.authorityHash)) {
            throw failure('native Codex Fast capability authority changed before WebSocket request', 'FAST_CAPABILITY_UNAVAILABLE');
        }
    }
    headers(prepared, credential) {
        return {
            authorization: `Bearer ${credential.accessToken}`,
            'chatgpt-account-id': credential.accountId,
            originator: 'dsh',
            'session-id': prepared.routingId,
            'thread-id': prepared.routingId,
            'x-client-request-id': prepared.routingId,
            'x-codex-routing-hint': prepared.routingHint,
            'openai-beta': WS_BETA,
            ...(prepared.generation.purpose === 'compaction' ? { 'x-openai-subagent': 'compact' } : {}),
            ...attributionHeaders(),
        };
    }
    async ensureSocket(entry, prepared, credential, signal, telemetry) {
        const fingerprint = socketCredential(credential);
        if (entry.socket !== undefined && entry.socketCredential === fingerprint)
            return;
        this.closeEntry(entry);
        const socket = await this.factory.connect({
            url: this.http.endpointUrl(),
            headers: this.headers(prepared, credential),
            signal,
            connectTimeoutMs: this.connectTimeoutMs,
        });
        if (this.disposed) {
            socket.close();
            throw failure('native Codex WebSocket transport was disposed', 'DISPOSED');
        }
        telemetry.activity();
        entry.socket = socket;
        entry.socketCredential = fingerprint;
        publishCodexRateLimits(credential.accountId, parseCodexRateLimitHeaders(socket.responseHeaders), this.options.onRateLimits, this.options.warn);
        const handshakeState = socket.responseHeaders['x-codex-turn-state'];
        if (entry.turnState === undefined && handshakeState !== undefined
            && Buffer.byteLength(handshakeState) <= MAX_TURN_STATE_BYTES) {
            entry.turnState = handshakeState;
        }
    }
    async receive(entry, signal) {
        if (entry.socket === undefined)
            throw failure('native Codex WebSocket is unavailable', 'WS_RETRYABLE');
        let timer;
        try {
            const frame = await Promise.race([
                entry.socket.receive(signal),
                new Promise((_resolve, reject) => {
                    timer = setTimeout(() => {
                        entry.socket?.close();
                        reject(failure('native Codex WebSocket response timed out', 'TIMEOUT'));
                    }, this.idleTimeoutMs);
                }),
            ]);
            if (frame.type === 'close') {
                throw failure('native Codex WebSocket closed before completion', 'WS_RETRYABLE');
            }
            return frame.text;
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    async *exchange(entry, payload, generation, mode, accountId, prewarm, signal, telemetry) {
        if (entry.socket === undefined)
            throw failure('native Codex WebSocket is unavailable', 'WS_RETRYABLE');
        const encoded = JSON.stringify(payload);
        await entry.socket.send(encoded, signal);
        telemetry.state('waiting');
        const translator = new ResponsesStreamTranslator(prewarm ? undefined : {
            provider: generation.provider,
            model: mode.publicModel ?? generation.model,
        });
        const outputItems = [];
        while (true) {
            const text = await this.receive(entry, signal);
            if (entry.socket?.observeActivity === undefined)
                telemetry.activity(Buffer.byteLength(text));
            let event;
            try {
                event = JSON.parse(text);
            }
            catch {
                this.options.warn?.('native Codex ignored a malformed WebSocket event');
                continue;
            }
            if (typeof event !== 'object' || event === null || typeof event.type !== 'string') {
                this.options.warn?.('native Codex ignored a malformed WebSocket event');
                continue;
            }
            const rawEvent = event;
            publishCodexResponseUsage(accountId, parseCodexResponseUsageMetadata(rawEvent), this.options.onResponseUsage, this.options.warn);
            const eventRateLimits = parseCodexRateLimitEvent(rawEvent);
            publishCodexRateLimits(accountId, eventRateLimits === undefined ? [] : [eventRateLimits], this.options.onRateLimits, this.options.warn);
            publishCodexRateLimits(accountId, parseCodexRateLimitHeaders(typeof rawEvent.headers === 'object' && rawEvent.headers !== null
                ? rawEvent.headers : undefined), this.options.onRateLimits, this.options.warn);
            const wrapped = eventFailure(rawEvent);
            if (wrapped !== undefined) {
                this.options.warn?.(rejectionDiagnostic(rawEvent));
                throw wrapped;
            }
            if (entry.turnState === undefined) {
                const nextTurnState = codexResponseTurnState(event);
                if (nextTurnState !== undefined)
                    entry.turnState = nextTurnState;
            }
            const chunks = translator.push(event);
            const output = normalizedOutputItem(event, translator);
            if (output !== undefined)
                outputItems.push(output);
            if (event.type === 'response.completed') {
                const response = typeof event.response === 'object'
                    && event.response !== null
                    ? event.response
                    : undefined;
                const responseId = typeof response?.id === 'string' ? response.id : '';
                entry.protocol.complete(responseId, outputItems);
            }
            if (!prewarm)
                for (const chunk of chunks)
                    yield chunk;
            if (translator.terminated) {
                if (event.type !== 'response.completed')
                    entry.protocol.reset();
                return;
            }
        }
    }
    async *attempt(entry, prepared, credential, signal, telemetry) {
        telemetry.attempt('websocket');
        await this.ensureSocket(entry, prepared, credential, signal, telemetry);
        const stopActivity = entry.socket?.observeActivity?.(bytes => telemetry.activity(bytes));
        try {
            let justPrewarmed = false;
            if (!entry.prewarmAttempted) {
                entry.prewarmAttempted = true;
                const warm = entry.protocol.prewarm(withRequestMetadata(prepared.request, entry.turnState, prepared.mode.responsesLite !== undefined));
                for await (const _chunk of this.exchange(entry, warm.payload, prepared.generation, prepared.mode, credential.accountId, true, signal, telemetry)) { /* prewarm is invisible */ }
                entry.prewarmSucceeded = true;
                justPrewarmed = true;
            }
            const plan = entry.protocol.plan(withRequestMetadata(prepared.request, entry.turnState, prepared.mode.responsesLite !== undefined), justPrewarmed);
            yield* this.exchange(entry, plan.payload, prepared.generation, prepared.mode, credential.accountId, false, signal, telemetry);
            if (this.options.onCompleted !== undefined) {
                try {
                    this.options.onCompleted();
                }
                catch {
                    this.options.warn?.('native Codex usage refresh could not be scheduled');
                }
            }
        }
        finally {
            stopActivity?.();
        }
    }
    async *stream(generation, mode = {}) {
        yield* trackNetwork(this.options.telemetry ?? networkTelemetry, 'websocket', generation.signal, handle => this.streamTracked(generation, mode, handle));
    }
    async *streamTracked(generation, mode, telemetry) {
        if (this.disposed)
            throw failure('native Codex WebSocket transport was disposed', 'DISPOSED');
        const lifecycle = new AbortController();
        const signal = generation.signal === undefined
            ? lifecycle.signal : AbortSignal.any([generation.signal, lifecycle.signal]);
        const activeGeneration = { ...generation, signal };
        this.preparing.add(lifecycle);
        let prepared;
        try {
            prepared = await this.http.prepare(activeGeneration, mode);
        }
        finally {
            this.preparing.delete(lifecycle);
        }
        if (this.disposed)
            throw failure('native Codex WebSocket transport was disposed', 'DISPOSED');
        const key = sessionKey(generation, prepared.routingId);
        const entry = this.entry(key);
        // A second request for the same DSH session (the session-title call racing
        // the first step, for example) cannot share one socket chain, and a
        // saturated pool has no socket to lend. Both still have a correct transport
        // over HTTP/SSE, so neither may fail the turn.
        if (entry.busy || this.active.size >= this.maxSessions) {
            this.options.warn?.(entry.busy
                ? 'native Codex WebSocket session already has an active request; serving this request over HTTP/SSE'
                : 'native Codex WebSocket active session limit was reached; serving this request over HTTP/SSE');
            yield* this.http.stream(activeGeneration, mode, telemetry);
            return;
        }
        entry.busy = true;
        this.active.set(entry, lifecycle);
        const currentTurn = turnKey(generation);
        if (entry.turnKey !== currentTurn) {
            entry.turnKey = currentTurn;
            entry.turnState = undefined;
        }
        const fallbackMode = () => ({
            ...mode,
            ...(entry.turnState === undefined ? {} : { turnState: entry.turnState }),
            captureTurnState: (state) => {
                if (entry.turnState === undefined)
                    entry.turnState = state;
            },
            ...(pinnedAccountId === undefined ? {} : { pinnedAccountId }),
        });
        let reconnects = 0;
        let connectionRetryDelayMs = INITIAL_CONNECTION_RETRY_DELAY_MS;
        let recovered = false;
        let pinnedAccountId = mode.pinnedAccountId;
        let requestCompleted = false;
        try {
            if (entry.disabled) {
                yield* this.http.stream(activeGeneration, fallbackMode(), telemetry);
                requestCompleted = true;
                return;
            }
            while (true) {
                let emitted = false;
                let attemptedCredential;
                const enteringPrewarm = !entry.prewarmAttempted;
                try {
                    telemetry.state('preparing');
                    const credential = await this.options.resolveCredential(signal);
                    attemptedCredential = credential;
                    if (pinnedAccountId === undefined)
                        pinnedAccountId = credential.accountId;
                    else if (credential.accountId !== pinnedAccountId) {
                        throw failure('native Codex account changed during request', 'AUTH');
                    }
                    this.assertFastAuthority(credential, mode);
                    for await (const chunk of this.attempt(entry, prepared, credential, signal, telemetry)) {
                        emitted = true;
                        observeNetworkOutput(telemetry, chunk);
                        yield chunk;
                    }
                    requestCompleted = true;
                    return;
                }
                catch (error) {
                    const failureValue = error instanceof LlmError
                        ? error : failure('native Codex WebSocket transport failed', 'WS_RETRYABLE', error);
                    this.closeEntry(entry);
                    if (this.disposed)
                        throw failure('native Codex WebSocket transport was disposed', 'DISPOSED');
                    if (generation.signal?.aborted || failureValue.code === 'ABORTED')
                        throw failureValue;
                    if (emitted) {
                        if (failedStepRetryable(failureValue.code))
                            throw failedStepRetry(failureValue);
                        throw failureValue;
                    }
                    // A rejected request is not a transient socket condition: retrying the
                    // socket repeats the rejection. The same payload has a correct
                    // transport over HTTP/SSE, so keep this DSH session on HTTP from now on
                    // instead of failing every later turn.
                    if (failureValue.code === 'INVALID_REQUEST') {
                        entry.disabled = true;
                        yield* this.http.stream(activeGeneration, fallbackMode(), telemetry);
                        requestCompleted = true;
                        return;
                    }
                    // Credential resolution may need the network itself, so wait until it recovers.
                    // Once a credential is available, however, a WebSocket-only outage must consume
                    // the bounded reconnect budget and then fall back to HTTP/SSE instead of leaving
                    // the DSH turn in an invisible infinite reconnect loop.
                    if (attemptedCredential === undefined
                        && isNativeCodexConnectionFailure(failureValue)) {
                        await this.waitForConnection(connectionRetryDelayMs, signal, telemetry);
                        connectionRetryDelayMs = Math.min(connectionRetryDelayMs * 2, MAX_CONNECTION_RETRY_DELAY_MS);
                        continue;
                    }
                    if (failureValue.code === 'WS_AUTH' && !recovered
                        && attemptedCredential !== undefined
                        && this.options.recoverCredential !== undefined) {
                        if (enteringPrewarm && !entry.prewarmSucceeded)
                            entry.prewarmAttempted = false;
                        try {
                            const changed = await this.options.recoverCredential(attemptedCredential, signal);
                            recovered = true;
                            if (changed) {
                                telemetry.retry(0);
                                continue;
                            }
                            throw failure('native Codex rejected the configured credential', 'AUTH');
                        }
                        catch (recoveryError) {
                            if (this.disposed) {
                                throw failure('native Codex WebSocket transport was disposed', 'DISPOSED');
                            }
                            if (generation.signal?.aborted)
                                throw recoveryError;
                            if (isNativeCodexConnectionFailure(recoveryError)) {
                                await this.waitForConnection(connectionRetryDelayMs, signal, telemetry);
                                connectionRetryDelayMs = Math.min(connectionRetryDelayMs * 2, MAX_CONNECTION_RETRY_DELAY_MS);
                                continue;
                            }
                            throw recoveryError;
                        }
                    }
                    const retryable = reconnectable(failureValue.code);
                    if (failureValue.code !== 'WS_UPGRADE_REQUIRED' && retryable
                        && enteringPrewarm && !entry.prewarmSucceeded) {
                        entry.prewarmAttempted = true;
                        await this.wait(0, failureValue, signal, telemetry);
                        continue;
                    }
                    if (failureValue.code !== 'WS_UPGRADE_REQUIRED' && retryable
                        && reconnects < this.maxReconnects) {
                        await this.wait(reconnects, failureValue, signal, telemetry);
                        reconnects++;
                        continue;
                    }
                    if (failureValue.code === 'WS_UPGRADE_REQUIRED' || retryable) {
                        entry.disabled = true;
                        if (remainingRetryDelay(failureValue) !== undefined) {
                            await this.wait(reconnects, failureValue, signal, telemetry);
                        }
                        else
                            telemetry.retry(0);
                        yield* this.http.stream(activeGeneration, fallbackMode(), telemetry);
                        requestCompleted = true;
                        return;
                    }
                    throw failureValue;
                }
            }
        }
        finally {
            this.active.delete(entry);
            entry.busy = false;
            entry.lastUsed = Date.now();
            if (!requestCompleted || !entry.pooled)
                this.closeEntry(entry);
        }
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const controller of this.preparing) {
            controller.abort(failure('native Codex WebSocket transport was disposed', 'DISPOSED'));
        }
        this.preparing.clear();
        for (const [entry, controller] of this.active) {
            controller.abort(failure('native Codex WebSocket transport was disposed', 'DISPOSED'));
            this.closeEntry(entry);
        }
        this.active.clear();
        for (const entry of this.sessions.values())
            this.closeEntry(entry);
        this.sessions.clear();
    }
}
