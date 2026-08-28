/** Bounded parsing for Codex subscription quota side channels. */
const MAX_TEXT_LENGTH = 128;
const MAX_LIMITS = 32;
const DEFAULT_LIMIT_ID = 'codex';
function boundedText(value) {
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim();
    return text.length > 0 && text.length <= MAX_TEXT_LENGTH ? text : undefined;
}
function finiteNumber(value) {
    const number = typeof value === 'number' ? value
        : typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined;
    return number !== undefined && Number.isFinite(number) ? number : undefined;
}
function safeNonNegativeInteger(value) {
    const number = finiteNumber(value);
    return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
function optionalBoolean(value) {
    if (typeof value === 'boolean')
        return value;
    if (value === '1' || (typeof value === 'string' && value.toLowerCase() === 'true'))
        return true;
    if (value === '0' || (typeof value === 'string' && value.toLowerCase() === 'false'))
        return false;
    return undefined;
}
function normalizedLimitId(value) {
    if (value === undefined || value === null)
        return DEFAULT_LIMIT_ID;
    const text = boundedText(value);
    return text?.toLowerCase().replaceAll('-', '_');
}
function rateLimitWindow(value, duration) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const row = value;
    const used = finiteNumber(row.used_percent ?? row.usedPercent);
    if (used === undefined)
        return undefined;
    const rawWindow = duration === 'minutes'
        ? safeNonNegativeInteger(row.window_minutes ?? row.windowMinutes)
        : safeNonNegativeInteger(row.limit_window_seconds ?? row.windowDurationSecs);
    const windowSeconds = rawWindow === undefined ? undefined
        : duration === 'minutes' && rawWindow <= Math.floor(Number.MAX_SAFE_INTEGER / 60)
            ? rawWindow * 60
            : duration === 'seconds' ? rawWindow : undefined;
    const resetAt = safeNonNegativeInteger(row.reset_at ?? row.resetsAt);
    return {
        usedPercent: Math.max(0, Math.min(100, used)),
        ...windowSeconds === undefined ? {} : { windowSeconds },
        ...resetAt === undefined ? {} : { resetAt },
    };
}
export function parseCodexRateLimitCredits(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const row = value;
    const hasCredits = optionalBoolean(row.has_credits ?? row.hasCredits);
    const unlimited = optionalBoolean(row.unlimited);
    if (hasCredits === undefined || unlimited === undefined)
        return undefined;
    const balance = boundedText(row.balance);
    return {
        hasCredits,
        unlimited,
        ...balance === undefined ? {} : { balance },
    };
}
/** Parse a `codex.rate_limits` WebSocket v2 event without trusting provider text. */
export function parseCodexRateLimitEvent(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const event = value;
    if (event.type !== 'codex.rate_limits')
        return undefined;
    const limits = event.rate_limits !== null && typeof event.rate_limits === 'object'
        && !Array.isArray(event.rate_limits)
        ? event.rate_limits : {};
    const primary = limits.primary === null ? null : rateLimitWindow(limits.primary, 'minutes');
    const secondary = limits.secondary === null ? null : rateLimitWindow(limits.secondary, 'minutes');
    const parsedCredits = parseCodexRateLimitCredits(event.credits);
    const planType = boundedText(event.plan_type ?? event.planType);
    const explicitReached = optionalBoolean(limits.limit_reached ?? limits.limitReached);
    const allowed = optionalBoolean(limits.allowed);
    const derivedReached = primary === undefined && secondary === undefined
        ? undefined : [primary, secondary].some(window => window?.usedPercent === 100);
    const limitReached = explicitReached
        ?? (allowed === undefined ? derivedReached : !allowed);
    if (primary === undefined && secondary === undefined && parsedCredits === undefined
        && planType === undefined && limitReached === undefined)
        return undefined;
    const rawLimitId = event.metered_limit_name ?? event.meteredLimitName
        ?? event.limit_name ?? event.limitName;
    const limitId = normalizedLimitId(rawLimitId);
    if (limitId === undefined)
        return undefined;
    const limitName = boundedText(event.limit_name ?? event.limitName);
    return {
        limitId,
        ...limitName === undefined ? {} : { limitName },
        ...planType === undefined ? {} : { planType },
        ...primary === undefined ? {} : { primary },
        ...secondary === undefined ? {} : { secondary },
        ...limitReached === undefined ? {} : { limitReached },
        ...parsedCredits === undefined ? {} : { credits: parsedCredits },
    };
}
function headerEntries(source) {
    if (source instanceof Headers) {
        const entries = [];
        source.forEach((value, name) => { entries.push([name.toLowerCase(), value]); });
        return entries;
    }
    return Object.entries(source).flatMap(([name, raw]) => {
        const value = Array.isArray(raw) ? raw[0] : raw;
        return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? [[name.toLowerCase(), String(value)]] : [];
    });
}
/** Parse every `x-<limit>-primary-*` quota header family on an HTTP or wrapped WS response. */
export function parseCodexRateLimitHeaders(source) {
    if (source === undefined)
        return [];
    const headers = new Map(headerEntries(source));
    const globalCredits = parseCodexRateLimitCredits({
        has_credits: headers.get('x-codex-credits-has-credits'),
        unlimited: headers.get('x-codex-credits-unlimited'),
        balance: headers.get('x-codex-credits-balance'),
    });
    const prefixes = new Set();
    for (const name of headers.keys()) {
        for (const suffix of ['-primary-used-percent', '-secondary-used-percent']) {
            if (name.startsWith('x-') && name.endsWith(suffix)) {
                prefixes.add(name.slice(0, -suffix.length));
            }
        }
    }
    if (globalCredits !== undefined)
        prefixes.add('x-codex');
    const updates = [];
    for (const prefix of [...prefixes].sort().slice(0, MAX_LIMITS)) {
        const primary = rateLimitWindow({
            used_percent: headers.get(`${prefix}-primary-used-percent`),
            window_minutes: headers.get(`${prefix}-primary-window-minutes`),
            reset_at: headers.get(`${prefix}-primary-reset-at`),
        }, 'minutes');
        const secondary = rateLimitWindow({
            used_percent: headers.get(`${prefix}-secondary-used-percent`),
            window_minutes: headers.get(`${prefix}-secondary-window-minutes`),
            reset_at: headers.get(`${prefix}-secondary-reset-at`),
        }, 'minutes');
        const parsedCredits = prefix === 'x-codex' ? globalCredits : undefined;
        if (primary === undefined && secondary === undefined && parsedCredits === undefined)
            continue;
        const limitId = normalizedLimitId(prefix.slice(2));
        if (limitId === undefined)
            continue;
        const limitName = boundedText(headers.get(`${prefix}-limit-name`));
        const limitReached = primary === undefined && secondary === undefined
            ? undefined : [primary, secondary].some(window => window?.usedPercent === 100);
        updates.push({
            limitId,
            ...limitName === undefined ? {} : { limitName },
            ...primary === undefined ? {} : { primary },
            ...secondary === undefined ? {} : { secondary },
            ...limitReached === undefined ? {} : { limitReached },
            ...parsedCredits === undefined ? {} : { credits: parsedCredits },
        });
    }
    return updates;
}
/** Publish optional quota metadata without letting diagnostics break a model stream. */
export function publishCodexRateLimits(accountId, updates, callback, warn) {
    if (updates.length === 0 || callback === undefined)
        return;
    try {
        callback({ accountId, updates });
    }
    catch {
        try {
            warn?.('native Codex rate-limit update could not be published');
        }
        catch {
            // Quota diagnostics are observational and must never fail generation.
        }
    }
}
