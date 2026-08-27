/** Bounded, cancellable Server-Sent Events byte framing. */
import { LlmError } from '@deepseek-ai/dsh-llm';
export const DEFAULT_MAX_SSE_EVENT_BYTES = 1024 * 1024;
function aborted() {
    return new LlmError('native Codex SSE stream was cancelled', 'ABORTED');
}
function tooLarge() {
    return new LlmError('native Codex SSE event exceeded the size limit', 'SSE_EVENT_TOO_LARGE');
}
/** Decode a byte stream into bounded SSE frames. */
export async function* parseSse(stream, options = {}) {
    const limit = options.maxEventBytes ?? DEFAULT_MAX_SSE_EVENT_BYTES;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new LlmError('native Codex SSE size limit is invalid', 'INVALID_CONFIG');
    }
    if (options.signal?.aborted === true)
        throw aborted();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let dataLines = [];
    let eventName;
    let eventBytes = 0;
    let cancelled = false;
    const onAbort = () => {
        cancelled = true;
        void reader.cancel(options.signal?.reason).catch(() => { });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        while (true) {
            if (cancelled || Boolean(options.signal?.aborted))
                throw aborted();
            const { done, value } = await reader.read();
            if (cancelled || Boolean(options.signal?.aborted))
                throw aborted();
            if (done)
                return;
            options.onActivity?.();
            options.onBytes?.(value.byteLength);
            pending += decoder.decode(value, { stream: true });
            if (Buffer.byteLength(pending) > limit && !pending.includes('\n'))
                throw tooLarge();
            let newline = pending.indexOf('\n');
            while (newline >= 0) {
                let line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                newline = pending.indexOf('\n');
                if (line.charCodeAt(line.length - 1) === 13)
                    line = line.slice(0, -1);
                if (line.length === 0) {
                    if (dataLines.length > 0) {
                        yield {
                            data: dataLines.join('\n'),
                            ...eventName === undefined ? {} : { event: eventName },
                        };
                    }
                    dataLines = [];
                    eventName = undefined;
                    eventBytes = 0;
                    continue;
                }
                eventBytes += Buffer.byteLength(line) + 1;
                if (eventBytes > limit)
                    throw tooLarge();
                if (line.startsWith(':'))
                    options.onActivity?.();
                else if (line.startsWith('data:'))
                    dataLines.push(line.slice(5).replace(/^ /, ''));
                else if (line.startsWith('event:'))
                    eventName = line.slice(6).replace(/^ /, '');
            }
        }
    }
    finally {
        options.signal?.removeEventListener('abort', onAbort);
        if (!cancelled)
            await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
