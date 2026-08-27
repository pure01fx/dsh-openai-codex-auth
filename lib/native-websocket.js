/** WebSocket v2 Responses transport with bounded session state and sticky HTTP fallback. */
import { createHash } from 'node:crypto';
import { LlmError, ProviderRequestId, attributionHeaders, } from '@deepseek-ai/dsh-llm';
import { nativeCodexAuthorityHash } from './catalog.js';
import { NativeCodexHttpTransport, } from './native-http.js';
import { replayableItemId } from './replay.js';
import { ResponsesStreamTranslator, codexResponseTurnState, } from './responses.js';
import { NodeNativeCodexWebSocketFactory, } from './native-websocket-socket.js';
import { NativeCodexWebSocketSessionState } from './native-websocket-session.js';
const WS_BETA = 'responses_websockets=2026-02-06';
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
const MAX_TURN_STATE_BYTES = 4096;
const MAX_EVENTS_PER_RESPONSE = 4096;
const MAX_OUTPUT_ITEMS_PER_RESPONSE = 2048;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
function failure(message, code, cause) {
    return new LlmError(message, code, cause === undefined ? undefined : { cause });
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
    const resolved = value ?? 2;
    if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 4) {
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
        if (message?.source.kind === 'user') {
            return createHash('sha256').update(String(message.id)).digest('base64url');
        }
    }
    return createHash('sha256')
        .update(`${generation.purpose ?? 'ordinary'}:handbuilt`).digest('base64url');
}
function withTurnState(request, turnState) {
    if (turnState === undefined)
        return request;
    const metadata = typeof request.client_metadata === 'object'
        && request.client_metadata !== null && !Array.isArray(request.client_metadata)
        ? request.client_metadata
        : {};
    return {
        ...request,
        client_metadata: { ...metadata, 'x-codex-turn-state': turnState },
    };
}
function normalizedOutputItem(event) {
    if (event.type !== 'response.output_item.done' || event.item === undefined)
        return undefined;
    const item = event.item;
    const id = replayableItemId(item.id);
    if (item.type === 'message') {
        return {
            type: 'message', ...(id === undefined ? {} : { id }), role: 'assistant',
            content: (item.content ?? []).map(part => ({ type: 'output_text', text: part.text })),
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
    const retryAfter = eventHeader(event, 'retry-after');
    const seconds = retryAfter === undefined ? undefined : Number(retryAfter);
    const retryMs = seconds !== undefined && Number.isFinite(seconds) && seconds > 0
        ? Math.min(seconds * 1_000, 120_000) : undefined;
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
        return new LlmError('native Codex WebSocket requested a fresh connection', 'WS_RETRYABLE_RESET', facts);
    }
    if (providerCode === 'unauthorized' || providerCode === 'invalid_api_key' || status === 401) {
        return new LlmError('native Codex WebSocket authentication failed', 'WS_AUTH', facts);
    }
    if (status === 403)
        return new LlmError('native Codex WebSocket authorization failed', 'AUTH', facts);
    if (providerCode === 'rate_limit_exceeded' || providerCode === 'usage_limit_reached'
        || status === 429) {
        return new LlmError('native Codex WebSocket rate limit was reached', 'RATE_LIMITED', facts);
    }
    if (status !== undefined && status >= 500) {
        return new LlmError('native Codex WebSocket service failed', 'WS_RETRYABLE', facts);
    }
    return new LlmError('native Codex WebSocket request was rejected', 'INVALID_REQUEST', facts);
}
/** Prefer WebSocket v2; once safe retries exhaust, keep that DSH session on HTTP. */
export class NativeCodexWebSocketTransport {
    options;
    http;
    factory;
    sessions = new Map();
    connectTimeoutMs;
    idleTimeoutMs;
    maxFrameBytes;
    maxSessions;
    sessionIdleMs;
    maxReconnects;
    active = new Map();
    disposed = false;
    constructor(options) {
        this.options = options;
        this.http = new NativeCodexHttpTransport(options);
        this.factory = options.webSocketFactory ?? new NodeNativeCodexWebSocketFactory();
        this.connectTimeoutMs = boundedPositive(options.webSocketConnectTimeoutMs, 10_000, 120_000, 'WebSocket connect timeout');
        this.idleTimeoutMs = boundedPositive(options.webSocketIdleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 60 * 60_000, 'WebSocket idle timeout');
        this.maxFrameBytes = boundedPositive(options.maxWebSocketFrameBytes, DEFAULT_MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, 'WebSocket frame limit');
        this.maxSessions = boundedPositive(options.maxWebSocketSessions, DEFAULT_MAX_SESSIONS, 256, 'WebSocket session limit');
        this.sessionIdleMs = boundedPositive(options.webSocketSessionIdleMs, DEFAULT_SESSION_IDLE_MS, 24 * 60 * 60_000, 'WebSocket session idle limit');
        this.maxReconnects = retryCount(options.maxWebSocketReconnects);
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
    async ensureSocket(entry, prepared, credential, signal) {
        const fingerprint = socketCredential(credential);
        if (entry.socket !== undefined && entry.socketCredential === fingerprint)
            return;
        this.closeEntry(entry);
        const socket = await this.factory.connect({
            url: this.http.endpointUrl(),
            headers: this.headers(prepared, credential),
            signal,
            connectTimeoutMs: this.connectTimeoutMs,
            maxFrameBytes: this.maxFrameBytes,
        });
        if (this.disposed) {
            socket.close();
            throw failure('native Codex WebSocket transport was disposed', 'DISPOSED');
        }
        entry.socket = socket;
        entry.socketCredential = fingerprint;
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
    async *exchange(entry, payload, generation, mode, prewarm, signal) {
        if (entry.socket === undefined)
            throw failure('native Codex WebSocket is unavailable', 'WS_RETRYABLE');
        const encoded = JSON.stringify(payload);
        if (Buffer.byteLength(encoded) > 24 * 1024 * 1024) {
            throw failure('native Codex WebSocket request exceeded the size limit', 'REQUEST_TOO_LARGE');
        }
        await entry.socket.send(encoded, signal);
        const translator = new ResponsesStreamTranslator(prewarm ? undefined : {
            provider: generation.provider,
            model: mode.publicModel ?? generation.model,
        });
        const outputItems = [];
        let events = 0;
        let responseBytes = 0;
        while (events++ < MAX_EVENTS_PER_RESPONSE) {
            const text = await this.receive(entry, signal);
            responseBytes += Buffer.byteLength(text);
            if (responseBytes > MAX_RESPONSE_BYTES) {
                throw failure('native Codex WebSocket response exceeded the size limit', 'WS_RESPONSE_TOO_LARGE');
            }
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
            const wrapped = eventFailure(event);
            if (wrapped !== undefined)
                throw wrapped;
            if (entry.turnState === undefined) {
                const nextTurnState = codexResponseTurnState(event);
                if (nextTurnState !== undefined)
                    entry.turnState = nextTurnState;
            }
            const output = normalizedOutputItem(event);
            if (output !== undefined) {
                if (outputItems.length >= MAX_OUTPUT_ITEMS_PER_RESPONSE) {
                    throw failure('native Codex WebSocket response had too many output items', 'WS_RESPONSE_TOO_LARGE');
                }
                outputItems.push(output);
            }
            if (event.type === 'response.completed') {
                const response = typeof event.response === 'object'
                    && event.response !== null
                    ? event.response
                    : undefined;
                const responseId = typeof response?.id === 'string' ? response.id : '';
                entry.protocol.complete(responseId, outputItems);
            }
            const chunks = translator.push(event);
            if (!prewarm)
                for (const chunk of chunks)
                    yield chunk;
            if (translator.terminated) {
                if (event.type !== 'response.completed')
                    entry.protocol.reset();
                return;
            }
        }
        throw failure('native Codex WebSocket response had too many events', 'WS_PROTOCOL_ERROR');
    }
    async *attempt(entry, prepared, credential, signal) {
        await this.ensureSocket(entry, prepared, credential, signal);
        let justPrewarmed = false;
        if (!entry.prewarmAttempted) {
            entry.prewarmAttempted = true;
            const warm = entry.protocol.prewarm(withTurnState(prepared.request, entry.turnState));
            for await (const _chunk of this.exchange(entry, warm.payload, prepared.generation, prepared.mode, true, signal)) { /* prewarm is invisible */ }
            entry.prewarmSucceeded = true;
            justPrewarmed = true;
        }
        const plan = entry.protocol.plan(withTurnState(prepared.request, entry.turnState), justPrewarmed);
        yield* this.exchange(entry, plan.payload, prepared.generation, prepared.mode, false, signal);
        if (this.options.onCompleted !== undefined) {
            try {
                this.options.onCompleted();
            }
            catch {
                this.options.warn?.('native Codex usage refresh could not be scheduled');
            }
        }
    }
    async *stream(generation, mode = {}) {
        if (this.disposed)
            throw failure('native Codex WebSocket transport was disposed', 'DISPOSED');
        const prepared = await this.http.prepare(generation, mode);
        if (this.disposed)
            throw failure('native Codex WebSocket transport was disposed', 'DISPOSED');
        const key = sessionKey(generation, prepared.routingId);
        const entry = this.entry(key);
        if (entry.busy)
            throw failure('native Codex WebSocket session already has an active request', 'CONCURRENT_REQUEST');
        if (this.active.size >= this.maxSessions) {
            throw failure('native Codex WebSocket active session limit was reached', 'WS_SESSION_LIMIT');
        }
        entry.busy = true;
        const lifecycle = new AbortController();
        this.active.set(entry, lifecycle);
        const signal = generation.signal === undefined
            ? lifecycle.signal : AbortSignal.any([generation.signal, lifecycle.signal]);
        const activeGeneration = { ...generation, signal };
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
        });
        let reconnects = 0;
        let recovered = false;
        let requestCompleted = false;
        try {
            if (entry.disabled) {
                yield* this.http.stream(activeGeneration, fallbackMode());
                requestCompleted = true;
                return;
            }
            while (true) {
                let emitted = false;
                let attemptedCredential;
                const enteringPrewarm = !entry.prewarmAttempted;
                try {
                    const credential = await this.options.resolveCredential(signal);
                    attemptedCredential = credential;
                    this.assertFastAuthority(credential, mode);
                    for await (const chunk of this.attempt(entry, prepared, credential, signal)) {
                        emitted = true;
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
                    if (emitted)
                        throw failureValue;
                    if (failureValue.code === 'WS_AUTH' && !recovered
                        && attemptedCredential !== undefined
                        && this.options.recoverCredential !== undefined) {
                        recovered = true;
                        if (enteringPrewarm && !entry.prewarmSucceeded)
                            entry.prewarmAttempted = false;
                        if (await this.options.recoverCredential(attemptedCredential, signal))
                            continue;
                        throw failure('native Codex rejected the configured credential', 'AUTH');
                    }
                    const retryable = [
                        'WS_RETRYABLE', 'WS_RETRYABLE_RESET', 'WS_PROTOCOL_ERROR',
                        'WS_FRAME_TOO_LARGE', 'WS_RESPONSE_TOO_LARGE', 'TIMEOUT',
                    ].includes(failureValue.code);
                    if (failureValue.code !== 'WS_UPGRADE_REQUIRED' && retryable
                        && enteringPrewarm && !entry.prewarmSucceeded) {
                        entry.prewarmAttempted = true;
                        continue;
                    }
                    if (failureValue.code !== 'WS_UPGRADE_REQUIRED' && retryable
                        && reconnects++ < this.maxReconnects) {
                        continue;
                    }
                    if (failureValue.code === 'WS_UPGRADE_REQUIRED' || retryable) {
                        entry.disabled = true;
                        yield* this.http.stream(activeGeneration, fallbackMode());
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
