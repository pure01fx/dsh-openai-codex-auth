/** Bounded per-response usage metadata emitted by the Codex Responses API. */
const MAX_AMOUNT_BYTES = 256;
const MAX_RAW_USAGE_BYTES = 64 * 1024;
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value : undefined;
}
function boundedJson(value) {
    if (value === undefined || value === null)
        return undefined;
    try {
        const encoded = JSON.stringify(value);
        if (encoded === undefined || Buffer.byteLength(encoded) > MAX_RAW_USAGE_BYTES)
            return undefined;
        return JSON.parse(encoded);
    }
    catch {
        return undefined;
    }
}
/** Preserve exact billing amount and the complete bounded response.usage payload. */
export function parseCodexResponseUsageMetadata(value) {
    const event = record(value);
    if (event?.type !== 'response.completed')
        return undefined;
    const response = record(event.response);
    const usageMetadata = record(response?.usage_metadata);
    const rawAmount = usageMetadata?.amount;
    const amount = typeof rawAmount === 'string' && rawAmount.length > 0
        && Buffer.byteLength(rawAmount) <= MAX_AMOUNT_BYTES
        ? rawAmount : undefined;
    const metadata = boundedJson(response?.usage);
    if (amount === undefined && metadata === undefined)
        return undefined;
    return {
        ...amount === undefined ? {} : { amount },
        ...metadata === undefined ? {} : { metadata },
    };
}
/** Publish optional response usage without allowing diagnostics to fail generation. */
export function publishCodexResponseUsage(accountId, metadata, callback, warn) {
    if (metadata === undefined || callback === undefined)
        return;
    try {
        callback({ accountId, metadata });
    }
    catch {
        try {
            warn?.('native Codex response usage metadata could not be published');
        }
        catch {
            // Per-response usage is observational and must never fail generation.
        }
    }
}
