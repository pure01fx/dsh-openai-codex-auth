/** Bounded per-response usage metadata emitted by the Codex Responses API. */
export interface CodexResponseUsageMetadata {
    /** Exact provider representation; never coerce this high-precision value to a number. */
    amount: string;
}
export interface CodexResponseUsageObservation {
    accountId: string;
    metadata: CodexResponseUsageMetadata;
}
export type CodexResponseUsageCallback = (observation: CodexResponseUsageObservation) => void;
/** Parse only response.completed usage_metadata.amount and preserve its exact string value. */
export declare function parseCodexResponseUsageMetadata(value: unknown): CodexResponseUsageMetadata | undefined;
/** Publish optional response usage without allowing diagnostics to fail generation. */
export declare function publishCodexResponseUsage(accountId: string, metadata: CodexResponseUsageMetadata | undefined, callback: CodexResponseUsageCallback | undefined, warn: ((message: string) => void) | undefined): void;
