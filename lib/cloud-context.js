import { LlmError } from '@deepseek-ai/dsh-llm';
export function chooseCloudModel(params, models) {
    const selected = params.requested ?? params.configured ?? (params.currentProvider === 'openai-codex' ? params.currentModel : undefined);
    if (!selected)
        throw new LlmError('Specify model or configure cloudTools.' + (params.purpose === 'search' ? 'searchModel' : 'visionModel') + '; the current session must otherwise use openai-codex', 'MODEL_REQUIRED');
    const model = models.find(item => item.slug === selected) ?? (selected.endsWith('-fast') ? models.find(item => item.slug === selected.slice(0, -5)) : undefined);
    if (!model)
        throw new LlmError('Selected Codex model is unavailable in the current account catalog', 'MODEL_NOT_FOUND');
    if (params.purpose === 'vision' && !model.inputModalities.includes('image'))
        throw new LlmError('Selected Codex model does not support image input', 'VISION_UNSUPPORTED');
    return model;
}
/** Only results paired with a preceding call and their owning source can grant image visibility. */
export function visibleCloudImages(messages) {
    const images = [];
    const calls = new Set();
    for (const message of messages) {
        if (message.role === 'assistant') {
            for (const block of message.content)
                if (block.type === 'tool-call')
                    calls.add(block.id);
        }
        else if (message.role === 'user' && message.source.kind === 'user') {
            // User messages grant only their direct images, never embedded purported tool results.
            for (const block of message.content)
                if (block.type === 'image')
                    images.push(block.attachment);
        }
        else if (message.role === 'tool' && message.source.kind === 'tool') {
            // Require successful result with matching callId and earlier matching call
            if (message.isError || message.toolCallId !== message.source.callId)
                continue;
            if (!calls.has(message.source.callId))
                continue;
            // Tool messages with images in their content
            for (const block of message.content)
                if (block.type === 'image')
                    images.push(block.attachment);
        }
    }
    return images;
}
function boundedText(text, bytes, tail = false) {
    const encoded = Buffer.from(text);
    if (encoded.length <= bytes)
        return text;
    if (tail) {
        let start = encoded.length - bytes;
        while (start < encoded.length && (encoded[start] & 0xc0) === 0x80)
            start++;
        return encoded.subarray(start).toString('utf8');
    }
    let end = bytes;
    while (end > 0 && (encoded[end] & 0xc0) === 0x80)
        end--;
    return encoded.subarray(0, end).toString('utf8');
}
/** Last two human texts plus intervening visible assistant text. UTF-8 bytes conservatively
 * upper-bound byte-level tokenizer tokens; a single 1000-byte assistant budget avoids
 * relying on an unavailable model tokenizer. The selected human texts are preserved in full. */
export function recentSearchInput(messages) {
    const users = messages.map((message, i) => message.role === 'user' && message.source.kind === 'user' && message.content.some(block => block.type === 'text') ? i : -1).filter(i => i >= 0).slice(-2);
    if (!users.length)
        return [];
    const selected = [];
    let assistantBytes = 1000;
    // Budget newest text first, then restore chronology.
    for (let i = messages.length - 1; i >= users[0]; i--) {
        const message = messages[i];
        const user = users.includes(i);
        if (!user && (message.role !== 'assistant' || message.source.kind !== 'model'))
            continue;
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        const content = user ? text : boundedText(text, assistantBytes, true);
        if (!content)
            continue;
        if (!user)
            assistantBytes -= Buffer.byteLength(content);
        selected.push({ role: user ? 'user' : 'assistant', content });
    }
    return selected.reverse();
}
