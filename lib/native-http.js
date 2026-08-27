/** Native ChatGPT Codex HTTP/SSE transport with safe pre-output retries. */
import { createHash, randomUUID } from 'node:crypto';
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, attributionHeaders, } from '@deepseek-ai/dsh-llm';
import { nativeCodexAuthorityHash } from './catalog.js';
import { codexRequestBody, streamResponses, } from './responses.js';
export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TRANSIENT_RETRIES = 4;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 200;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 24 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
function aborted(message = 'native Codex request was aborted') {
    return new LlmError(message, 'ABORTED');
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw aborted();
}
function fixedFailure(message, code, options) {
    return new LlmError(message, code, options);
}
function safePositiveInteger(value, fallback, name) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw fixedFailure(`native Codex ${name} is invalid`, 'INVALID_CONFIG');
    }
    return resolved;
}
function safeRetryCount(value) {
    const resolved = value ?? DEFAULT_MAX_TRANSIENT_RETRIES;
    if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 10) {
        throw fixedFailure('native Codex retry count is invalid', 'INVALID_CONFIG');
    }
    return resolved;
}
function stablePromptCacheKey(sessionId) {
    const bytes = createHash('sha256').update(sessionId).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function sleep(delayMs, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, delayMs);
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(aborted('native Codex retry wait was aborted'));
        };
        function done() {
            signal?.removeEventListener('abort', abort);
            resolve();
        }
        signal?.addEventListener('abort', abort, { once: true });
    });
}
function attemptWatchdog(parent, requestMs, idleMs) {
    const controller = new AbortController();
    let timeout;
    let expired = false;
    let idle = false;
    const expire = () => {
        expired = true;
        controller.abort();
    };
    const arm = () => {
        if (timeout !== undefined)
            clearTimeout(timeout);
        timeout = setTimeout(expire, idle ? idleMs : requestMs);
    };
    const fromParent = () => { controller.abort(parent?.reason); };
    if (parent?.aborted)
        fromParent();
    else
        parent?.addEventListener('abort', fromParent, { once: true });
    arm();
    return {
        signal: controller.signal,
        timedOut: () => expired,
        beginIdle: () => { idle = true; arm(); },
        pulse: () => { if (idle)
            arm(); },
        stop: () => {
            if (timeout !== undefined)
                clearTimeout(timeout);
            parent?.removeEventListener('abort', fromParent);
            if (!controller.signal.aborted)
                controller.abort();
        },
    };
}
async function resolveImage(block, options, signal) {
    if (options.readImage === undefined) {
        throw fixedFailure('native Codex image input requires the attachment service', 'UNSUPPORTED');
    }
    throwIfAborted(signal);
    const stored = await options.readImage(block.attachment, signal);
    throwIfAborted(signal);
    if (!(stored.data instanceof Uint8Array) || stored.data.byteLength !== block.attachment.bytes) {
        throw fixedFailure('native Codex attachment bytes failed verification', 'INVALID_ATTACHMENT');
    }
    return {
        type: 'image',
        mediaType: block.attachment.mediaType,
        dataBase64: Buffer.from(stored.data).toString('base64'),
    };
}
async function resolveToolResult(block, options, signal) {
    const content = [];
    for (const part of block.content) {
        throwIfAborted(signal);
        if (part.type === 'text')
            content.push(part);
        else if (part.type === 'image')
            content.push(await resolveImage(part, options, signal));
        else {
            throw fixedFailure('native Codex tool output contains an unsupported content block', 'UNSUPPORTED');
        }
    }
    return {
        type: 'tool-result',
        toolCallId: block.toolCallId,
        content,
        ...block.isError === undefined ? {} : { isError: block.isError },
    };
}
async function resolveMessages(generation, options) {
    const messages = [];
    for (const message of generation.messages) {
        const content = [];
        for (const block of message.content) {
            throwIfAborted(generation.signal);
            switch (block.type) {
                case 'text':
                    content.push(block);
                    break;
                case 'reasoning':
                    if (message.role !== 'assistant') {
                        throw fixedFailure('native Codex reasoning history requires assistant messages', 'INVALID_ARGS');
                    }
                    content.push(block);
                    break;
                case 'image':
                    if (message.role !== 'user') {
                        throw fixedFailure('native Codex supports image input only in user messages', 'UNSUPPORTED');
                    }
                    content.push(await resolveImage(block, options, generation.signal));
                    break;
                case 'tool-call':
                    if (message.role !== 'assistant') {
                        throw fixedFailure('native Codex tool calls require assistant messages', 'INVALID_ARGS');
                    }
                    content.push(block);
                    break;
                case 'tool-result':
                    if (message.role !== 'user') {
                        throw fixedFailure('native Codex tool results require user messages', 'INVALID_ARGS');
                    }
                    content.push(await resolveToolResult(block, options, generation.signal));
                    break;
                default:
                    throw fixedFailure('native Codex request contains an unsupported content block', 'UNSUPPORTED');
            }
        }
        const source = message.source;
        const replaySource = message.role === 'assistant' && source?.kind === 'model'
            && source.replayState !== undefined
            ? { provider: source.provider, model: source.model, replayState: source.replayState }
            : undefined;
        messages.push({
            role: message.role,
            content,
            ...(replaySource === undefined ? {} : { replaySource }),
        });
    }
    return messages;
}
async function boundedError(response, signal) {
    if (response.body === null)
        return {};
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let cancelled = false;
    const onAbort = () => {
        cancelled = true;
        void reader.cancel(signal?.reason).catch(() => { });
    };
    if (signal?.aborted)
        onAbort();
    else
        signal?.addEventListener('abort', onAbort, { once: true });
    try {
        while (true) {
            if (cancelled)
                return {};
            const { done, value } = await reader.read();
            if (cancelled)
                return {};
            if (done)
                break;
            total += value.byteLength;
            if (total > MAX_ERROR_BODY_BYTES) {
                await reader.cancel().catch(() => { });
                return {};
            }
            chunks.push(value);
        }
    }
    catch {
        return {};
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
        reader.releaseLock();
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), total).toString('utf8'));
        if (typeof value !== 'object' || value === null)
            return {};
        const outer = value;
        const row = typeof outer.error === 'object' && outer.error !== null
            ? outer.error
            : outer;
        return {
            ...typeof row.code === 'string' ? { code: row.code } : {},
            ...typeof row.message === 'string' ? { message: row.message } : {},
        };
    }
    catch {
        return {};
    }
}
function retryAfterMs(response, maxDelayMs) {
    const raw = response.headers.get('retry-after');
    if (raw === null)
        return undefined;
    const seconds = Number(raw);
    const value = Number.isFinite(seconds)
        ? seconds * 1_000
        : Date.parse(raw) - Date.now();
    return Number.isFinite(value) && value > 0 ? Math.min(value, maxDelayMs) : undefined;
}
function errorFacts(response, maxDelayMs) {
    const providerRetryAfterMs = retryAfterMs(response, maxDelayMs);
    const requestId = response.headers.get('x-request-id');
    return {
        status: response.status,
        ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
        ...requestId === null || requestId.length === 0 || requestId.length > 256
            ? {}
            : { requestId: ProviderRequestId(requestId) },
    };
}
async function httpFailure(response, maxDelayMs, signal) {
    const detail = await boundedError(response, signal);
    const facts = errorFacts(response, maxDelayMs);
    const classification = `${detail.code ?? ''} ${detail.message ?? ''}`;
    if (response.status === 401 || response.status === 403) {
        return fixedFailure('native Codex rejected the configured credential', 'AUTH', facts);
    }
    if (response.status === 429) {
        if (isQuotaExceededError(classification)) {
            return fixedFailure('native Codex account quota is exhausted', QUOTA_EXCEEDED_CODE, facts);
        }
        return fixedFailure('native Codex request was rate limited', 'RATE_LIMIT', facts);
    }
    if (detail.code === 'context_length_exceeded'
        || detail.code === 'context_window_exceeded'
        || isContextWindowExceededError(classification)) {
        return fixedFailure('native Codex request exceeded the model context window', CONTEXT_WINDOW_EXCEEDED_CODE, facts);
    }
    if (isQuotaExceededError(classification)) {
        return fixedFailure('native Codex account quota is exhausted', QUOTA_EXCEEDED_CODE, facts);
    }
    if (response.status === 408 || response.status === 504) {
        return fixedFailure('native Codex request timed out', 'TIMEOUT', facts);
    }
    if (response.status >= 500) {
        return fixedFailure('native Codex server request failed', 'SERVER', facts);
    }
    return fixedFailure('native Codex request was rejected', 'INVALID_REQUEST', facts);
}
function mappedFailure(error, watchdog, parent) {
    if (parent?.aborted)
        return aborted();
    if (watchdog.timedOut())
        return fixedFailure('native Codex request timed out', 'TIMEOUT');
    if (error instanceof LlmError)
        return error;
    return fixedFailure('native Codex transport failed', 'TRANSPORT', { cause: error });
}
function retryable(error) {
    return ['TRANSPORT', 'SERVER', 'TIMEOUT', 'STREAM_CLOSED'].includes(error.code);
}
/** HTTP Responses transport. It never retains a credential outside one attempt. */
export class NativeCodexHttpTransport {
    options;
    fetchImpl;
    endpoint;
    requestTimeoutMs;
    idleTimeoutMs;
    maxRetries;
    initialDelayMs;
    maxDelayMs;
    maxBodyBytes;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetch ?? fetch;
        this.endpoint = options.endpoint ?? CODEX_RESPONSES_URL;
        this.requestTimeoutMs = safePositiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'request timeout');
        this.idleTimeoutMs = safePositiveInteger(options.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS, 'stream idle timeout');
        this.maxRetries = safeRetryCount(options.maxTransientRetries);
        this.initialDelayMs = safePositiveInteger(options.initialRetryDelayMs, DEFAULT_INITIAL_RETRY_DELAY_MS, 'initial retry delay');
        this.maxDelayMs = safePositiveInteger(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS, 'maximum retry delay');
        this.maxBodyBytes = safePositiveInteger(options.maxRequestBodyBytes, DEFAULT_MAX_REQUEST_BODY_BYTES, 'request body limit');
    }
    retryDelay(retry, providerDelay) {
        if (providerDelay !== undefined)
            return Math.min(providerDelay, this.maxDelayMs);
        const exponential = Math.min(this.initialDelayMs * (2 ** retry), this.maxDelayMs);
        const random = this.options.random?.() ?? Math.random();
        const jitter = 0.9 + Math.max(0, Math.min(1, random)) * 0.2;
        return Math.max(1, Math.round(exponential * jitter));
    }
    async wait(retry, error, signal) {
        const delay = this.retryDelay(retry, error.failure.providerRetryAfterMs);
        await (this.options.sleep ?? sleep)(delay, signal);
    }
    async *stream(generation, mode = {}) {
        throwIfAborted(generation.signal);
        if (generation.model.length === 0 || generation.model.length > 256
            || /[\r\n\0;]/u.test(generation.model)) {
            throw fixedFailure('native Codex model identity is invalid', 'INVALID_ARGS');
        }
        const messages = await resolveMessages(generation, this.options);
        throwIfAborted(generation.signal);
        const sessionId = generation.sessionId === undefined ? undefined : String(generation.sessionId);
        if (sessionId !== undefined
            && (sessionId.length === 0 || sessionId.length > 256 || /[\r\n\0]/u.test(sessionId))) {
            throw fixedFailure('native Codex session identity is invalid', 'INVALID_ARGS');
        }
        const routingId = sessionId ?? (this.options.createRequestId?.() ?? randomUUID());
        const routingHint = mode.serviceTier === undefined
            ? `model=${generation.model}`
            : `model=${generation.model};tier=${mode.serviceTier}`;
        const wireOptions = sessionId === undefined
            ? generation
            : {
                ...generation,
                sessionId: stablePromptCacheKey(sessionId),
            };
        let body;
        try {
            body = JSON.stringify(codexRequestBody(wireOptions, messages, mode));
        }
        catch (error) {
            if (error instanceof LlmError)
                throw error;
            throw fixedFailure('native Codex request could not be encoded', 'INVALID_ARGS', { cause: error });
        }
        if (Buffer.byteLength(body) > this.maxBodyBytes) {
            throw fixedFailure('native Codex request exceeded the size limit', 'REQUEST_TOO_LARGE');
        }
        let transientRetries = 0;
        let recovered = false;
        while (true) {
            throwIfAborted(generation.signal);
            const watchdog = attemptWatchdog(generation.signal, this.requestTimeoutMs, this.idleTimeoutMs);
            let response;
            let credential;
            try {
                credential = await this.options.resolveCredential(watchdog.signal);
                throwIfAborted(watchdog.signal);
                if (mode.serviceTier !== undefined
                    && (mode.authorityHash === undefined
                        || nativeCodexAuthorityHash(credential.accountId) !== mode.authorityHash)) {
                    throw fixedFailure('native Codex Fast capability authority changed before request', 'FAST_CAPABILITY_UNAVAILABLE');
                }
                response = await this.fetchImpl(this.endpoint, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${credential.accessToken}`,
                        'chatgpt-account-id': credential.accountId,
                        originator: 'dsh',
                        'session-id': routingId,
                        'thread-id': routingId,
                        'x-client-request-id': routingId,
                        'x-codex-routing-hint': routingHint,
                        ...(generation.purpose === 'compaction' ? { 'x-openai-subagent': 'compact' } : {}),
                        accept: 'text/event-stream',
                        'content-type': 'application/json',
                        ...attributionHeaders(),
                    },
                    body,
                    signal: watchdog.signal,
                });
            }
            catch (error) {
                const failure = mappedFailure(error, watchdog, generation.signal);
                watchdog.stop();
                if (retryable(failure) && transientRetries < this.maxRetries) {
                    await this.wait(transientRetries++, failure, generation.signal);
                    continue;
                }
                throw failure;
            }
            if (response.status === 401 && !recovered && this.options.recoverCredential !== undefined) {
                try {
                    recovered = true;
                    await response.body?.cancel(watchdog.signal.reason);
                    const changed = await this.options.recoverCredential(credential, watchdog.signal);
                    watchdog.stop();
                    if (changed)
                        continue;
                    throw fixedFailure('native Codex rejected the configured credential', 'AUTH', errorFacts(response, this.maxDelayMs));
                }
                catch (error) {
                    const failure = mappedFailure(error, watchdog, generation.signal);
                    watchdog.stop();
                    throw failure;
                }
            }
            if (!response.ok) {
                let failure = await httpFailure(response, this.maxDelayMs, watchdog.signal);
                if (generation.signal?.aborted || watchdog.timedOut()) {
                    failure = mappedFailure(failure, watchdog, generation.signal);
                }
                watchdog.stop();
                if (retryable(failure) && transientRetries < this.maxRetries) {
                    await this.wait(transientRetries++, failure, generation.signal);
                    continue;
                }
                throw failure;
            }
            if (response.body === null) {
                watchdog.stop();
                throw fixedFailure('native Codex returned no response stream', EMPTY_RESPONSE_CODE);
            }
            watchdog.beginIdle();
            let emitted = false;
            let completed = false;
            try {
                for await (const chunk of streamResponses(response.body, {
                    signal: watchdog.signal,
                    onActivity: watchdog.pulse,
                    ...this.options.maxSseEventBytes === undefined
                        ? {}
                        : { maxEventBytes: this.options.maxSseEventBytes },
                    onMalformedEvent: () => {
                        this.options.warn?.('native Codex ignored a malformed SSE event');
                    },
                    replayContext: {
                        provider: generation.provider,
                        model: mode.publicModel ?? generation.model,
                    },
                })) {
                    emitted = true;
                    if (chunk.type === 'finish'
                        && ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason.kind))
                        completed = true;
                    yield chunk;
                }
                watchdog.stop();
                if (completed && this.options.onCompleted !== undefined) {
                    try {
                        this.options.onCompleted();
                    }
                    catch {
                        this.options.warn?.('native Codex usage refresh could not be scheduled');
                    }
                }
                return;
            }
            catch (error) {
                const failure = mappedFailure(error, watchdog, generation.signal);
                watchdog.stop();
                if (!emitted && retryable(failure) && transientRetries < this.maxRetries) {
                    await this.wait(transientRetries++, failure, generation.signal);
                    continue;
                }
                throw failure;
            }
        }
    }
}
