/** Bounded per-response usage metadata emitted by the Codex Responses API. */
export interface CodexResponseUsageMetadata {
    /** Exact provider representation; never coerce this high-precision value to a number. */
    amount?: string;
    /** Complete bounded `response.usage` JSON, including fields unknown to this client. */
    metadata?: unknown;
}
export interface CodexResponseUsageObservation {
    accountId: string;
    metadata: CodexResponseUsageMetadata;
}
export type CodexResponseUsageCallback = (observation: CodexResponseUsageObservation) => void;
/** Preserve exact billing amount and the complete bounded response.usage payload. */
export declare function parseCodexResponseUsageMetadata(value: unknown): CodexResponseUsageMetadata | undefined;
/** Publish optional response usage without allowing diagnostics to fail generation. */
export declare function publishCodexResponseUsage(accountId: string, metadata: CodexResponseUsageMetadata | undefined, callback: CodexResponseUsageCallback | undefined, warn: ((message: string) => void) | undefined): void;
