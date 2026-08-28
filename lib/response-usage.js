/** Bounded per-response usage metadata emitted by the Codex Responses API. */
const MAX_AMOUNT_BYTES = 256;
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value : undefined;
}
/** Parse only response.completed usage_metadata.amount and preserve its exact string value. */
export function parseCodexResponseUsageMetadata(value) {
    const event = record(value);
    if (event?.type !== 'response.completed')
        return undefined;
    const response = record(event.response);
    const metadata = record(response?.usage_metadata);
    const amount = metadata?.amount;
    if (typeof amount !== 'string' || amount.length === 0
        || Buffer.byteLength(amount) > MAX_AMOUNT_BYTES)
        return undefined;
    return { amount };
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
