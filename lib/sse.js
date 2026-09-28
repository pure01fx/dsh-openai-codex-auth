/** Cancellable Server-Sent Events byte framing. */
import { LlmError } from '@deepseek-ai/dsh-llm';
function aborted() {
    return new LlmError('native Codex SSE stream was cancelled', 'ABORTED');
}
/** Decode a byte stream into SSE frames. */
export async function* parseSse(stream, options = {}) {
    if (options.signal?.aborted === true)
        throw aborted();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let dataLines = [];
    let eventName;
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
                    continue;
                }
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
