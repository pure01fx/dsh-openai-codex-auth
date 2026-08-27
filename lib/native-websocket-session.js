/** Pure WebSocket v2 previous-response and incremental suffix state. */
import { createHash } from 'node:crypto';
import { LlmError } from '@deepseek-ai/dsh-llm';
const MAX_SESSION_ITEMS = 2048;
const MAX_RESPONSE_ID_BYTES = 256;
const IGNORED_REUSE_FIELDS = new Set([
    'input', 'previous_response_id', 'generate', 'client_metadata',
    'stream_options', 'access_programs',
]);
function failure(message, code = 'WS_PROTOCOL_ERROR') {
    return new LlmError(message, code);
}
function canonical(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    const row = value;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
function digest(value) {
    return createHash('sha256').update(canonical(value)).digest('base64url');
}
function requestParts(request) {
    if (!Array.isArray(request.input))
        throw failure('native Codex WebSocket input is invalid', 'INVALID_ARGS');
    if (request.input.length > MAX_SESSION_ITEMS) {
        throw failure('native Codex WebSocket input has too many items', 'REQUEST_TOO_LARGE');
    }
    const properties = Object.fromEntries(Object.entries(request).filter(([key]) => !IGNORED_REUSE_FIELDS.has(key)));
    return {
        propertyHash: digest(properties),
        input: request.input,
        inputHashes: request.input.map(digest),
    };
}
function hasPrefix(current, prefix) {
    return prefix.length <= current.length && prefix.every((value, index) => current[index] === value);
}
/** One socket chain. Reset it whenever the socket reconnects or a request fails. */
export class NativeCodexWebSocketSessionState {
    completed;
    pending;
    plan(request, allowEmptySuffix = false) {
        const current = requestParts(request);
        const prefix = this.completed === undefined
            ? undefined
            : [...this.completed.inputHashes, ...this.completed.outputHashes];
        const reusable = this.completed !== undefined
            && this.completed.propertyHash === current.propertyHash
            && prefix !== undefined
            && hasPrefix(current.inputHashes, prefix)
            && (allowEmptySuffix || current.input.length > prefix.length);
        this.pending = { propertyHash: current.propertyHash, inputHashes: current.inputHashes };
        if (!reusable || prefix === undefined || this.completed === undefined) {
            return { payload: { type: 'response.create', ...request }, incremental: false };
        }
        return {
            payload: {
                type: 'response.create',
                ...request,
                previous_response_id: this.completed.responseId,
                input: current.input.slice(prefix.length),
            },
            incremental: true,
            previousResponseId: this.completed.responseId,
        };
    }
    prewarm(request) {
        const plan = this.plan(request);
        return { ...plan, payload: { ...plan.payload, generate: false } };
    }
    complete(responseId, outputItems) {
        if (this.pending === undefined || responseId.length === 0
            || Buffer.byteLength(responseId) > MAX_RESPONSE_ID_BYTES) {
            this.reset();
            throw failure('native Codex WebSocket completion identity is invalid');
        }
        if (outputItems.length > MAX_SESSION_ITEMS) {
            this.reset();
            throw failure('native Codex WebSocket response has too many items');
        }
        this.completed = {
            ...this.pending,
            responseId,
            outputHashes: outputItems.map(digest),
        };
        this.pending = undefined;
    }
    reset() {
        this.completed = undefined;
        this.pending = undefined;
    }
}
