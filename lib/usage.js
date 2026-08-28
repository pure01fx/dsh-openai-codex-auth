/** Account-scoped subscription quota projection and reconciliation. */
import { parseCodexRateLimitCredits, } from './rate-limits.js';
function optionalNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function usageWindow(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const row = value;
    const usedPercent = optionalNumber(row.used_percent ?? row.usedPercent);
    if (usedPercent === undefined)
        return undefined;
    const windowSeconds = optionalNumber(row.limit_window_seconds ?? row.windowDurationSecs);
    const resetAt = optionalNumber(row.reset_at ?? row.resetsAt);
    return {
        usedPercent: Math.max(0, Math.min(100, usedPercent)),
        ...windowSeconds === undefined ? {} : { windowSeconds },
        ...resetAt === undefined ? {} : { resetAt },
    };
}
function boundedUsageText(value) {
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim();
    return text.length > 0 && text.length <= 128 ? text : undefined;
}
function normalizedUsageLimitId(value) {
    return boundedUsageText(value)?.toLowerCase().replaceAll('-', '_');
}
function usageLimit(id, name, value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const row = value;
    const primary = usageWindow(row.primary_window ?? row.primary);
    const secondary = usageWindow(row.secondary_window ?? row.secondary);
    const limitReached = typeof row.limit_reached === 'boolean'
        ? row.limit_reached
        : typeof row.limitReached === 'boolean' ? row.limitReached : undefined;
    if (primary === undefined && secondary === undefined && limitReached === undefined)
        return undefined;
    return {
        id,
        ...name === undefined ? {} : { name },
        ...primary === undefined ? {} : { primary },
        ...secondary === undefined ? {} : { secondary },
        ...limitReached === undefined ? {} : { limitReached },
    };
}
function sortedUsageLimits(limits) {
    return [...limits].sort((left, right) => {
        if (left.id === 'codex')
            return right.id === 'codex' ? 0 : -1;
        if (right.id === 'codex')
            return 1;
        return left.id.localeCompare(right.id);
    }).slice(0, 32);
}
/** Reduce a full `wham/usage` payload to bounded fields displayed by the Web card. */
export function normalizeUsage(value) {
    const root = value !== null && typeof value === 'object' ? value : {};
    const defaultValue = root.rate_limit ?? root.rateLimits;
    const defaultLimit = usageLimit('codex', undefined, defaultValue);
    const limits = defaultLimit === undefined ? [] : [defaultLimit];
    const additional = root.additional_rate_limits ?? root.additionalRateLimits;
    if (Array.isArray(additional)) {
        for (const value of additional.slice(0, 31)) {
            if (value === null || typeof value !== 'object' || Array.isArray(value))
                continue;
            const row = value;
            const id = normalizedUsageLimitId(row.metered_feature ?? row.meteredFeature);
            if (id === undefined || id === 'codex' || limits.some(limit => limit.id === id))
                continue;
            const extra = usageLimit(id, boundedUsageText(row.limit_name ?? row.limitName), row.rate_limit ?? row.rateLimit);
            if (extra !== undefined)
                limits.push(extra);
        }
    }
    const sortedLimits = sortedUsageLimits(limits);
    const projected = sortedLimits.find(limit => limit.id === 'codex') ?? sortedLimits[0];
    const resetCreditValue = root.rate_limit_reset_credits ?? root.rateLimitResetCredits;
    const resetCreditRow = resetCreditValue !== null && typeof resetCreditValue === 'object'
        ? resetCreditValue : undefined;
    const resetCredits = optionalNumber(resetCreditRow?.available_count ?? resetCreditRow?.availableCount);
    const planType = boundedUsageText(root.plan_type ?? root.planType);
    const parsedCredits = parseCodexRateLimitCredits(root.credits);
    return {
        ...planType === undefined ? {} : { planType },
        ...projected?.primary === undefined ? {} : { primary: projected.primary },
        ...projected?.secondary === undefined ? {} : { secondary: projected.secondary },
        ...projected?.limitReached === undefined ? {} : { limitReached: projected.limitReached },
        ...resetCredits === undefined ? {} : { resetCredits },
        ...parsedCredits === undefined ? {} : { credits: parsedCredits },
        ...sortedLimits.length === 0 ? {} : { limits: sortedLimits },
        source: 'endpoint',
        fetchedAt: Date.now(),
    };
}
function mergeUsageWindow(previous, update) {
    return {
        usedPercent: update.usedPercent,
        ...update.windowSeconds === undefined
            ? previous?.windowSeconds === undefined ? {} : { windowSeconds: previous.windowSeconds }
            : { windowSeconds: update.windowSeconds },
        ...update.resetAt === undefined
            ? previous?.resetAt === undefined ? {} : { resetAt: previous.resetAt }
            : { resetAt: update.resetAt },
    };
}
function mergeUsageLimit(previous, update) {
    const primary = update.primary === undefined ? previous?.primary
        : update.primary === null ? undefined : mergeUsageWindow(previous?.primary, update.primary);
    const secondary = update.secondary === undefined ? previous?.secondary
        : update.secondary === null ? undefined : mergeUsageWindow(previous?.secondary, update.secondary);
    const name = update.limitName ?? previous?.name;
    const limitReached = update.limitReached ?? previous?.limitReached;
    return {
        id: update.limitId,
        ...name === undefined ? {} : { name },
        ...primary === undefined ? {} : { primary },
        ...secondary === undefined ? {} : { secondary },
        ...limitReached === undefined ? {} : { limitReached },
    };
}
/** Merge sparse direct transport observations while retaining endpoint-only metadata. */
export function mergeDirectUsage(previous, updates) {
    const byId = new Map((previous?.limits ?? []).map(limit => [limit.id, limit]));
    if (byId.size === 0 && previous !== undefined
        && (previous.primary !== undefined || previous.secondary !== undefined
            || previous.limitReached !== undefined)) {
        byId.set('codex', {
            id: 'codex',
            ...previous.primary === undefined ? {} : { primary: previous.primary },
            ...previous.secondary === undefined ? {} : { secondary: previous.secondary },
            ...previous.limitReached === undefined ? {} : { limitReached: previous.limitReached },
        });
    }
    for (const update of updates.slice(0, 32)) {
        byId.set(update.limitId, mergeUsageLimit(byId.get(update.limitId), update));
    }
    const limits = sortedUsageLimits(byId.values());
    const projected = limits.find(limit => limit.id === 'codex') ?? limits[0];
    const planType = updates.find(update => update.planType !== undefined)?.planType ?? previous?.planType;
    const parsedCredits = updates.find(update => update.credits !== undefined)?.credits ?? previous?.credits;
    const resetCredits = previous?.resetCredits;
    const hasDirectDefault = updates.some(update => update.limitId === 'codex'
        && (update.primary !== undefined || update.secondary !== undefined));
    const source = hasDirectDefault ? 'response' : previous?.source ?? 'response';
    const fetchedAt = hasDirectDefault ? Date.now() : previous?.fetchedAt ?? Date.now();
    return {
        ...planType === undefined ? {} : { planType },
        ...projected?.primary === undefined ? {} : { primary: projected.primary },
        ...projected?.secondary === undefined ? {} : { secondary: projected.secondary },
        ...projected?.limitReached === undefined ? {} : { limitReached: projected.limitReached },
        ...resetCredits === undefined ? {} : { resetCredits },
        ...parsedCredits === undefined ? {} : { credits: parsedCredits },
        ...limits.length === 0 ? {} : { limits },
        source,
        fetchedAt,
    };
}
