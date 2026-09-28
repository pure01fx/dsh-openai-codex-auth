/** One explicit, tool-free Codex image understanding request. */
import { randomUUID } from 'node:crypto';
import { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { nativeCodexWireReasoningEffort } from './native-adapter.js';
import { NativeCodexHttpTransport } from './native-http.js';
import { validateImageSelection } from './cloud-images.js';
export function parseCloudVisionArgs(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Vision arguments must be an object');
    const row = value;
    if (Object.keys(row).some(key => !['prompt', 'images', 'model', 'detail', 'reasoning_effort'].includes(key)))
        throw new Error('Unknown vision argument');
    if (typeof row.prompt !== 'string' || !row.prompt.trim())
        throw new Error('Vision prompt must be a nonempty string');
    const selection = validateImageSelection(row);
    if (!selection.images)
        throw new Error('Vision requires explicit images');
    for (const key of ['model', 'reasoning_effort']) {
        if (row[key] !== undefined && (typeof row[key] !== 'string' || !row[key].trim() || Buffer.byteLength(row[key]) > 256))
            throw new Error('Invalid vision ' + key);
    }
    if (row.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(row.detail))
        throw new Error('Invalid vision detail');
    return { prompt: row.prompt, images: selection.images,
        ...(row.model === undefined ? {} : { model: row.model }),
        ...(row.detail === undefined ? {} : { detail: row.detail }),
        ...(row.reasoning_effort === undefined ? {} : { reasoning_effort: row.reasoning_effort }) };
}
export async function inspectCloudImages(args, deps) {
    const { model } = deps;
    deps.signal.throwIfAborted();
    if (!model.inputModalities.includes('image'))
        throw new LlmError('Select a Codex model with image input', 'VISION_UNSUPPORTED');
    if (deps.images.length !== args.images.length)
        throw new Error('Resolved vision images do not match the request');
    const requested = args.detail ?? deps.defaultDetail ?? 'auto';
    const effective = model.useResponsesLite ? undefined
        : requested === 'original' && !model.supportsImageDetailOriginal ? 'high' : requested;
    const images = deps.images.map(image => {
        if (!image.width || !image.height)
            throw new Error('Vision requires verified encoded image dimensions');
        // Ephemeral references are resolved only by this invocation's reader, never persisted.
        const ref = { attachmentId: ('vision-' + randomUUID()),
            mediaType: image.mediaType, bytes: image.data.byteLength, width: image.width, height: image.height };
        return { image, ref };
    });
    const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(120_000)]);
    let recovered = false;
    const transport = new NativeCodexHttpTransport({ ...deps.transport, maxTransientRetries: 0,
        resolveCredential: async (readSignal) => {
            const current = recovered ? await deps.transport.resolveCredential(readSignal) : deps.credential;
            if (current.accountId !== deps.credential.accountId)
                throw new LlmError('Codex account changed during image inspection', 'CODEX_ACCOUNT_CHANGED');
            return current;
        },
        recoverCredential: async (previous, readSignal) => {
            const ok = await deps.transport.recoverCredential?.(previous, readSignal) ?? false;
            recovered = ok;
            return ok;
        },
        readImage: async (ref) => {
            const entry = images.find(image => image.ref.attachmentId === ref.attachmentId);
            if (!entry)
                throw new LlmError('Image is outside this inspection request', 'INVALID_ATTACHMENT');
            return { data: entry.image.data, ...(effective === undefined ? {} : { detail: effective }) };
        } });
    const effort = nativeCodexWireReasoningEffort(args.reasoning_effort ?? (model.useResponsesLite ? model.defaultReasoningLevel : undefined), model);
    const chunks = transport.stream({ provider: 'openai-codex', model: model.slug, signal,
        system: 'Analyze the provided images and answer the user request. State uncertainty where image details are unclear.',
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: args.prompt }, ...images.map(({ ref }) => ({ type: 'image', attachment: ref }))] })],
        tools: [], ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }) }, { pinnedAccountId: deps.credential.accountId, ...(model.useResponsesLite ? { responsesLite: {
                ...(model.defaultVerbosity === undefined ? {} : { defaultVerbosity: model.defaultVerbosity }),
                ...(model.instructionsTemplate === undefined ? {} : { instructionsTemplate: model.instructionsTemplate }),
            } } : {}) });
    const texts = new Map();
    let usage;
    let finished = false;
    for await (const chunk of chunks) {
        if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call'))
            throw new LlmError('Image inspection returned an unexpected tool call', 'UNSUPPORTED');
        if (chunk.type === 'block-end' && chunk.block.type === 'text') {
            texts.set(chunk.index, chunk.block.text);
        }
        if (chunk.type === 'usage')
            usage = chunk.usage;
        if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error')
                throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code);
            if (chunk.reason.kind !== 'stop')
                throw new LlmError('Image inspection did not complete normally', 'INCOMPLETE_RESPONSE');
            finished = true;
        }
    }
    const text = [...texts.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('');
    if (!finished || !text.trim())
        throw new LlmError('Image inspection returned no completed text', 'EMPTY_RESPONSE');
    return { text, model: model.slug, ...(usage === undefined ? {} : { usage }), images: images.map(({ image }) => ({
            requested_detail: requested, effective_detail: effective ?? 'omitted', width: image.width, height: image.height, scaled: image.scaled,
        })) };
}
