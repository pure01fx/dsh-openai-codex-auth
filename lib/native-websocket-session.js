/** Pure WebSocket v2 previous-response and incremental suffix state. */
import { createHash } from 'node:crypto';
import { LlmError } from '@deepseek-ai/dsh-llm';
const MAX_OUTPUT_ITEMS = 2048;
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
const EMPTY_SEQUENCE_HASH = digest([]);
/** Match ordered prefixes without retaining one hash per historical input item. */
function extendSequenceHash(sequenceHash, items) {
    let current = sequenceHash;
    for (const item of items) {
        current = createHash('sha256')
            .update(current).update(String.fromCharCode(0)).update(digest(item))
            .digest('base64url');
    }
    return current;
}
function requestParts(request, prefixLength) {
    if (!Array.isArray(request.input))
        throw failure('native Codex WebSocket input is invalid', 'INVALID_ARGS');
    const properties = Object.fromEntries(Object.entries(request).filter(([key]) => !IGNORED_REUSE_FIELDS.has(key)));
    let inputHash = EMPTY_SEQUENCE_HASH;
    let prefixHash = prefixLength === 0 ? inputHash : undefined;
    for (let index = 0; index < request.input.length; index++) {
        inputHash = extendSequenceHash(inputHash, [request.input[index]]);
        if (index + 1 === prefixLength)
            prefixHash = inputHash;
    }
    return {
        propertyHash: digest(properties),
        input: request.input,
        inputHash,
        ...(prefixHash === undefined ? {} : { prefixHash }),
    };
}
/** One socket chain. Reset it whenever the socket reconnects or a request fails. */
export class NativeCodexWebSocketSessionState {
    completed;
    pending;
    plan(request, allowEmptySuffix = false) {
        const prefixLength = this.completed?.contextLength;
        const current = requestParts(request, prefixLength);
        const reusable = this.completed !== undefined
            && this.completed.propertyHash === current.propertyHash
            && current.prefixHash === this.completed.contextHash
            && (allowEmptySuffix || current.input.length > this.completed.contextLength);
        this.pending = {
            propertyHash: current.propertyHash,
            inputLength: current.input.length,
            inputHash: current.inputHash,
        };
        if (!reusable || this.completed === undefined) {
            return { payload: { type: 'response.create', ...request }, incremental: false };
        }
        return {
            payload: {
                type: 'response.create',
                ...request,
                previous_response_id: this.completed.responseId,
                input: current.input.slice(this.completed.contextLength),
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
        if (outputItems.length > MAX_OUTPUT_ITEMS) {
            this.reset();
            throw failure('native Codex WebSocket response has too many items');
        }
        this.completed = {
            propertyHash: this.pending.propertyHash,
            contextLength: this.pending.inputLength + outputItems.length,
            contextHash: extendSequenceHash(this.pending.inputHash, outputItems),
            responseId,
        };
        this.pending = undefined;
    }
    reset() {
        this.completed = undefined;
        this.pending = undefined;
    }
}
