/** Bounded parsing for Codex subscription quota side channels. */
export interface CodexRateLimitWindow {
    usedPercent: number;
    windowSeconds?: number;
    resetAt?: number;
}
export interface CodexRateLimitCredits {
    hasCredits: boolean;
    unlimited: boolean;
    balance?: string;
}
/** One provider quota bucket observed on an HTTP response or WebSocket event. */
export interface CodexRateLimitUpdate {
    limitId: string;
    limitName?: string;
    planType?: string;
    primary?: CodexRateLimitWindow | null;
    secondary?: CodexRateLimitWindow | null;
    limitReached?: boolean;
    credits?: CodexRateLimitCredits;
}
export interface CodexRateLimitObservation {
    accountId: string;
    updates: readonly CodexRateLimitUpdate[];
}
export type CodexRateLimitCallback = (observation: CodexRateLimitObservation) => void;
type HeaderSource = Headers | Readonly<Record<string, unknown>>;
export declare function parseCodexRateLimitCredits(value: unknown): CodexRateLimitCredits | undefined;
/** Parse a `codex.rate_limits` WebSocket v2 event without trusting provider text. */
export declare function parseCodexRateLimitEvent(value: unknown): CodexRateLimitUpdate | undefined;
/** Parse every `x-<limit>-primary-*` quota header family on an HTTP or wrapped WS response. */
export declare function parseCodexRateLimitHeaders(source: HeaderSource | undefined): CodexRateLimitUpdate[];
/** Publish optional quota metadata without letting diagnostics break a model stream. */
export declare function publishCodexRateLimits(accountId: string, updates: readonly CodexRateLimitUpdate[], callback: CodexRateLimitCallback | undefined, warn: ((message: string) => void) | undefined): void;
export {};
