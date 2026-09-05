/** Account-scoped subscription quota projection and reconciliation. */
import { type CodexRateLimitCredits, type CodexRateLimitUpdate } from './rate-limits.js';
export interface UsageWindow {
    usedPercent: number;
    windowSeconds?: number;
    resetAt?: number;
}
export interface UsageLimitSummary {
    id: string;
    name?: string;
    normalModelSlug?: string;
    primary?: UsageWindow;
    secondary?: UsageWindow;
    limitReached?: boolean;
}
export interface UsageSummary {
    planType?: string;
    primary?: UsageWindow;
    secondary?: UsageWindow;
    limitReached?: boolean;
    resetCredits?: number;
    credits?: CodexRateLimitCredits;
    limits?: UsageLimitSummary[];
    source: 'response' | 'endpoint';
    fetchedAt: number;
}
/** Reduce a full `wham/usage` payload to bounded fields displayed by the Web card. */
export declare function normalizeUsage(value: unknown): UsageSummary;
/** Merge sparse direct transport observations while retaining endpoint-only metadata. */
export declare function mergeDirectUsage(previous: UsageSummary | undefined, updates: readonly CodexRateLimitUpdate[]): UsageSummary;
