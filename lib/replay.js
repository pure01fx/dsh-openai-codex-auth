/** Bounded, versioned Codex Responses continuation state. */
import { LlmError } from '@deepseek-ai/dsh-llm';
export const NATIVE_CODEX_REPLAY_KIND = 'openai-codex-native.responses-replay';
export const NATIVE_CODEX_REPLAY_VERSION = 1;
const MAX_REPLAY_ITEM_ID_BYTES = 256;
const MAX_REPLAY_CIPHERTEXT_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_STATE_BYTES = 64 * 1024 * 1024;
function failure(message, code = 'INVALID_REPLAY_STATE') {
    return new LlmError(message, code);
}
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function onlyKeys(row, keys) {
    const allowed = new Set(keys);
    return Object.keys(row).every(key => allowed.has(key));
}
function boundedString(value, maximum = 256) {
    return typeof value === 'string' && value.length > 0
        && Buffer.byteLength(value) <= maximum ? value : undefined;
}
/** Preserve only server item IDs that Codex itself would replay. */
export function replayableItemId(value) {
    if (value === undefined)
        return undefined;
    if (Buffer.byteLength(value) > MAX_REPLAY_ITEM_ID_BYTES) {
        throw failure('native Codex response item identity exceeded the replay limit', 'MALFORMED_RESPONSE');
    }
    const split = value.indexOf('_');
    return split > 0 && split < value.length - 1 ? value : undefined;
}
function safeStateSize(value, code) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    }
    catch {
        throw failure('native Codex replay state is not lossless JSON', code);
    }
    if (Buffer.byteLength(serialized) > MAX_REPLAY_STATE_BYTES) {
        throw failure('native Codex replay state exceeded the size limit', code);
    }
}
function validateBlockArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const blocks = [];
    for (const item of value) {
        if (!Number.isSafeInteger(item) || Number(item) < 0)
            return undefined;
        blocks.push(Number(item));
    }
    return blocks;
}
function parseDescriptor(value) {
    const row = object(value);
    if (row === undefined || typeof row.type !== 'string') {
        throw failure('native Codex replay descriptor is invalid');
    }
    const id = row.id === undefined ? undefined : boundedString(row.id, MAX_REPLAY_ITEM_ID_BYTES);
    const split = id?.indexOf('_') ?? -1;
    if (row.id !== undefined && (id === undefined || split <= 0 || split >= id.length - 1)) {
        throw failure('native Codex replay item identity is invalid');
    }
    if (row.type === 'message') {
        const blocks = validateBlockArray(row.blocks);
        if (blocks === undefined || !onlyKeys(row, ['type', 'id', 'blocks'])) {
            throw failure('native Codex message replay descriptor is invalid');
        }
        return { type: 'message', ...(id === undefined ? {} : { id }), blocks };
    }
    if (row.type === 'reasoning') {
        const blocks = validateBlockArray(row.blocks);
        const encryptedContent = row.encryptedContent === undefined
            ? undefined : boundedString(row.encryptedContent, MAX_REPLAY_CIPHERTEXT_BYTES);
        if (blocks === undefined
            || (row.encryptedContent !== undefined && encryptedContent === undefined)
            || !onlyKeys(row, ['type', 'id', 'blocks', 'encryptedContent'])) {
            throw failure('native Codex reasoning replay descriptor is invalid');
        }
        return {
            type: 'reasoning', ...(id === undefined ? {} : { id }), blocks,
            ...(encryptedContent === undefined ? {} : { encryptedContent }),
        };
    }
    if (row.type === 'function_call') {
        if (!Number.isSafeInteger(row.block) || Number(row.block) < 0
            || !onlyKeys(row, ['type', 'id', 'block'])) {
            throw failure('native Codex function replay descriptor is invalid');
        }
        return { type: 'function_call', ...(id === undefined ? {} : { id }), block: Number(row.block) };
    }
    throw failure('native Codex replay descriptor type is unsupported');
}
function replayPayload(value) {
    const response = object(value)?.response;
    return object(response)?.kind === NATIVE_CODEX_REPLAY_KIND ? response : value;
}
/** True only for legacy raw state or an rc.2 envelope emitted by this package. */
export function hasNativeCodexReplayKind(value) {
    return object(replayPayload(value))?.kind === NATIVE_CODEX_REPLAY_KIND;
}
function parseState(value) {
    const payload = replayPayload(value);
    safeStateSize(payload, 'INVALID_REPLAY_STATE');
    const row = object(payload);
    if (row === undefined || row.kind !== NATIVE_CODEX_REPLAY_KIND
        || row.version !== NATIVE_CODEX_REPLAY_VERSION
        || !onlyKeys(row, ['kind', 'version', 'provider', 'model', 'items'])) {
        throw failure('native Codex replay state kind or version is invalid');
    }
    const provider = boundedString(row.provider);
    const model = boundedString(row.model, 512);
    if (provider === undefined || model === undefined || !Array.isArray(row.items)
        || row.items.length === 0) {
        throw failure('native Codex replay state metadata is invalid');
    }
    const items = row.items.map(parseDescriptor);
    return {
        kind: NATIVE_CODEX_REPLAY_KIND,
        version: NATIVE_CODEX_REPLAY_VERSION,
        provider,
        model,
        items,
    };
}
/** Attempt-local byte-bounded accumulator; no ciphertext can grow unchecked before completion. */
export class NativeCodexReplayCapture {
    provider;
    model;
    descriptors = [];
    stateBytes;
    constructor(provider, model) {
        this.provider = provider;
        this.model = model;
        this.stateBytes = Buffer.byteLength(JSON.stringify({
            kind: NATIVE_CODEX_REPLAY_KIND,
            version: NATIVE_CODEX_REPLAY_VERSION,
            provider,
            model,
            items: [],
        }));
    }
    add(item) {
        if (item.type === 'reasoning' && item.encryptedContent !== undefined
            && Buffer.byteLength(item.encryptedContent) > MAX_REPLAY_CIPHERTEXT_BYTES) {
            throw failure('native Codex encrypted reasoning exceeded the replay limit', 'MALFORMED_RESPONSE');
        }
        const itemBytes = Buffer.byteLength(JSON.stringify(item));
        const nextBytes = this.stateBytes + itemBytes + (this.descriptors.length === 0 ? 0 : 1);
        if (nextBytes > MAX_REPLAY_STATE_BYTES) {
            throw failure('native Codex replay state exceeded the size limit', 'REPLAY_STATE_TOO_LARGE');
        }
        this.descriptors.push(item);
        this.stateBytes = nextBytes;
    }
    finish() {
        return createNativeCodexReplayState(this.provider, this.model, this.descriptors);
    }
}
/** Create state only for a successful response with completed replay descriptors. */
export function createNativeCodexReplayState(provider, model, items) {
    if (items.length === 0)
        return undefined;
    const state = {
        kind: NATIVE_CODEX_REPLAY_KIND,
        version: NATIVE_CODEX_REPLAY_VERSION,
        provider,
        model,
        items: items.map(item => ({ ...item })),
    };
    safeStateSize(state, 'REPLAY_STATE_TOO_LARGE');
    try {
        return parseState(state);
    }
    catch {
        throw failure('native Codex completed items cannot form replay state', 'MALFORMED_RESPONSE');
    }
}
function blockAt(content, used, index, expected) {
    const block = content[index];
    if (block === undefined || block.type !== expected || used.has(index)) {
        throw failure('native Codex replay block reference is invalid');
    }
    used.add(index);
    return block;
}
/** Reconstruct provider items without duplicating durable visible block payloads in state. */
export function replayAssistantInput(content, source) {
    const state = parseState(source.replayState);
    if (state.provider !== source.provider || state.model !== source.model) {
        throw failure('native Codex replay provenance does not match its assistant message');
    }
    const used = new Set();
    const input = [];
    for (const item of state.items) {
        if (item.type === 'message') {
            const parts = item.blocks.map((index) => {
                const block = blockAt(content, used, index, 'text');
                return { type: 'output_text', text: block.text };
            });
            input.push({
                type: 'message', ...(item.id === undefined ? {} : { id: item.id }),
                role: 'assistant', content: parts,
            });
        }
        else if (item.type === 'reasoning') {
            const summary = item.blocks.map((index) => {
                const block = blockAt(content, used, index, 'reasoning');
                return { type: 'summary_text', text: block.text };
            });
            input.push({
                type: 'reasoning', ...(item.id === undefined ? {} : { id: item.id }), summary,
                ...(item.encryptedContent === undefined ? {} : { encrypted_content: item.encryptedContent }),
            });
        }
        else {
            const block = blockAt(content, used, item.block, 'tool-call');
            input.push({
                type: 'function_call', ...(item.id === undefined ? {} : { id: item.id }),
                call_id: String(block.id), name: block.name, arguments: block.arguments,
            });
        }
    }
    if (used.size !== content.length) {
        throw failure('native Codex replay state does not cover every assistant block');
    }
    return input;
}
