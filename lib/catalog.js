/** Native Codex model discovery, validation, and account-partitioned caching. */
import { createHash } from 'node:crypto';
import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm';
export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
/** Backend-compatible Codex catalog version; the pinned workspace's 0.0.0 is a development placeholder. */
export const CODEX_CLIENT_VERSION = '0.147.0';
export const CODEX_CATALOG_CACHE_TTL_MS = 5 * 60_000;
const CODEX_CATALOG_MAX_STALE_MS = 7 * 24 * 60 * 60_000;
const CODEX_CATALOG_TIMEOUT_MS = 5_000;
const MAX_CATALOG_BODY_LENGTH = 2 * 1024 * 1024;
const ORIGINATOR = 'dsh';
class CatalogFetchError extends LlmError {
    allowsStale;
    constructor(message, code, allowsStale, options) {
        super(message, code, options);
        this.allowsStale = allowsStale;
    }
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new LlmError('native Codex catalog request was aborted', 'ABORTED');
}
function awaitWithSignal(promise, signal) {
    if (signal === undefined)
        return promise;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const abort = () => {
            reject(new LlmError('native Codex catalog request was aborted', 'ABORTED'));
        };
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', abort);
        });
    });
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function positiveNumber(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function invalidCatalog(message) {
    return new CatalogFetchError(message, 'CATALOG_INVALID_RESPONSE', true);
}
function strictStringList(value, fallback = []) {
    if (value === undefined)
        return fallback;
    if (!Array.isArray(value)
        || !value.every(item => typeof item === 'string' && item.length > 0))
        return undefined;
    return value;
}
function parseReasoningLevels(value) {
    if (!Array.isArray(value))
        return undefined;
    const levels = [];
    for (const item of value) {
        const row = record(item);
        if (row === undefined)
            return undefined;
        const effort = nonEmptyString(row?.effort);
        const description = nonEmptyString(row?.description);
        if (effort === undefined || description === undefined)
            return undefined;
        levels.push({ effort, description });
    }
    return levels;
}
function parseServiceTiers(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        return undefined;
    const tiers = [];
    for (const item of value) {
        const row = record(item);
        if (row === undefined)
            return undefined;
        const id = nonEmptyString(row?.id);
        const name = nonEmptyString(row?.name);
        const description = nonEmptyString(row?.description);
        if (id === undefined || name === undefined || description === undefined)
            return undefined;
        tiers.push({ id, name, description });
    }
    return tiers;
}
async function boundedResponseText(response) {
    if (response.body === null)
        return '';
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > MAX_CATALOG_BODY_LENGTH) {
                await reader.cancel();
                throw new CatalogFetchError('native Codex catalog response exceeded the size limit', 'CATALOG_INVALID_RESPONSE', true);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), total).toString('utf8');
}
function parseModel(value) {
    const row = record(value);
    if (row === undefined)
        throw invalidCatalog('native Codex catalog contained a non-object model entry');
    const slug = nonEmptyString(row?.slug);
    const displayName = nonEmptyString(row?.display_name);
    const reasoning = parseReasoningLevels(row?.supported_reasoning_levels);
    const visibility = row?.visibility;
    const priority = row?.priority;
    const additionalSpeedTiers = strictStringList(row?.additional_speed_tiers);
    const serviceTiers = parseServiceTiers(row?.service_tiers);
    const inputModalities = strictStringList(row?.input_modalities, ['text', 'image']);
    if (slug === undefined
        || displayName === undefined
        || reasoning === undefined
        || !['list', 'hide', 'none'].includes(String(visibility))
        || !['unified_exec', 'disabled', 'default', 'local', 'shell_command'].includes(String(row?.shell_type))
        || typeof row.supported_in_api !== 'boolean'
        || typeof priority !== 'number' || !Number.isSafeInteger(priority)
        || priority < -2_147_483_648 || priority > 2_147_483_647
        || additionalSpeedTiers === undefined
        || serviceTiers === undefined
        || inputModalities === undefined
        || !inputModalities.every(value => ['text', 'image', 'audio'].includes(value))) {
        throw invalidCatalog('native Codex catalog contained an invalid model entry');
    }
    if (row.description !== undefined && row.description !== null && typeof row.description !== 'string') {
        throw invalidCatalog('native Codex catalog contained an invalid model description');
    }
    if (row.default_reasoning_level !== undefined
        && row.default_reasoning_level !== null
        && nonEmptyString(row.default_reasoning_level) === undefined) {
        throw invalidCatalog('native Codex catalog contained an invalid default reasoning level');
    }
    if (row.default_service_tier !== undefined
        && row.default_service_tier !== null
        && nonEmptyString(row.default_service_tier) === undefined) {
        throw invalidCatalog('native Codex catalog contained an invalid default service tier');
    }
    for (const key of ['context_window', 'max_context_window']) {
        if (row[key] !== undefined && row[key] !== null && positiveNumber(row[key]) === undefined) {
            throw invalidCatalog('native Codex catalog contained an invalid context window');
        }
    }
    const description = nonEmptyString(row.description);
    const defaultReasoningLevel = nonEmptyString(row.default_reasoning_level);
    const defaultServiceTier = nonEmptyString(row.default_service_tier);
    const contextWindow = positiveNumber(row.context_window) ?? positiveNumber(row.max_context_window);
    return {
        slug,
        displayName,
        ...description === undefined ? {} : { description },
        ...defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel },
        supportedReasoningLevels: reasoning,
        visibility: visibility,
        supportedInApi: row.supported_in_api,
        priority,
        additionalSpeedTiers,
        serviceTiers,
        ...defaultServiceTier === undefined ? {} : { defaultServiceTier },
        ...contextWindow === undefined ? {} : { contextWindow },
        inputModalities,
    };
}
function parseModelsPayload(value) {
    const rows = record(value)?.models;
    if (!Array.isArray(rows))
        throw invalidCatalog('native Codex catalog response has no models array');
    if (rows.length === 0) {
        throw new CatalogFetchError('native Codex catalog response contained no usable models', 'CATALOG_EMPTY', true);
    }
    const models = rows.map(parseModel);
    const slugs = new Set(models.map(model => model.slug));
    if (slugs.size !== models.length)
        throw invalidCatalog('native Codex catalog contained duplicate model ids');
    if (!models.some(model => model.visibility === 'list')) {
        throw new CatalogFetchError('native Codex catalog response contained no picker-visible models', 'CATALOG_EMPTY', true);
    }
    return models;
}
export function nativeCodexAuthorityHash(accountId) {
    return createHash('sha256').update(accountId).digest('hex');
}
/** Codex-compatible live catalog with bounded stale fallback and no credential retention. */
export class NativeCodexCatalog {
    options;
    endpoint;
    clientVersion;
    cacheTtlMs;
    maxStaleMs;
    timeoutMs;
    fetchImpl;
    now;
    snapshot;
    refreshes = new Map();
    currentEtag;
    constructor(options) {
        this.options = options;
        this.endpoint = options.endpoint ?? CODEX_MODELS_URL;
        this.clientVersion = options.clientVersion ?? CODEX_CLIENT_VERSION;
        this.cacheTtlMs = options.cacheTtlMs ?? CODEX_CATALOG_CACHE_TTL_MS;
        this.maxStaleMs = options.maxStaleMs ?? CODEX_CATALOG_MAX_STALE_MS;
        this.timeoutMs = options.timeoutMs ?? CODEX_CATALOG_TIMEOUT_MS;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
    }
    etag() {
        return this.currentEtag;
    }
    async list(signal) {
        return (await this.listWithAuthority(signal)).models;
    }
    async listWithAuthority(signal) {
        throwIfAborted(signal);
        this.currentEtag = undefined;
        let credential;
        try {
            credential = await this.options.resolveCredential(signal);
        }
        catch (error) {
            if (error instanceof LlmError && error.code === 'ABORTED')
                throw error;
            if (!(error instanceof LlmError) || error.code !== 'MISSING_CREDENTIAL') {
                this.options.warn?.('native Codex credential is unavailable; model metadata is advisory');
            }
            return { models: [] };
        }
        throwIfAborted(signal);
        const hash = nativeCodexAuthorityHash(credential.accountId);
        const cached = this.snapshot?.clientVersion === this.clientVersion
            && this.snapshot.accountHash === hash
            ? this.snapshot
            : undefined;
        throwIfAborted(signal);
        const age = cached === undefined ? Number.POSITIVE_INFINITY : this.now() - cached.fetchedAt;
        if (cached !== undefined && age >= 0 && age <= this.cacheTtlMs) {
            this.currentEtag = cached.etag;
            return { models: cached.models, authorityHash: hash };
        }
        try {
            let refresh = this.refreshes.get(hash);
            if (refresh === undefined) {
                const started = this.fetchCatalog(credential, hash)
                    .then((fresh) => {
                    this.snapshot = fresh;
                    return fresh;
                })
                    .finally(() => {
                    if (this.refreshes.get(hash) === started)
                        this.refreshes.delete(hash);
                });
                refresh = started;
                this.refreshes.set(hash, refresh);
            }
            const fresh = await awaitWithSignal(refresh, signal);
            this.currentEtag = fresh.etag;
            return { models: fresh.models, authorityHash: hash };
        }
        catch (error) {
            if (error instanceof LlmError && error.code === 'ABORTED')
                throw error;
            if (error instanceof CatalogFetchError
                && error.allowsStale
                && cached !== undefined
                && age >= 0
                && age <= this.maxStaleMs) {
                this.currentEtag = cached.etag;
                this.options.warn?.(`native Codex catalog refresh failed (${error.code}); using bounded stale cache`);
                return { models: cached.models, authorityHash: hash };
            }
            const code = error instanceof LlmError ? error.code : 'UNKNOWN';
            this.options.warn?.(`native Codex catalog refresh failed (${code}); model metadata is advisory`);
            return { models: [], authorityHash: hash };
        }
    }
    async fetchCatalog(credential, hash, signal) {
        const controller = new AbortController();
        const abortFromCaller = () => { controller.abort(signal?.reason); };
        if (signal !== undefined)
            signal.addEventListener('abort', abortFromCaller, { once: true });
        const timeout = setTimeout(() => { controller.abort(new Error('catalog timeout')); }, this.timeoutMs);
        try {
            throwIfAborted(signal);
            const url = new URL(this.endpoint);
            url.searchParams.set('client_version', this.clientVersion);
            let response;
            try {
                response = await this.fetchImpl(url, {
                    method: 'GET',
                    headers: {
                        authorization: `Bearer ${credential.accessToken}`,
                        'chatgpt-account-id': credential.accountId,
                        originator: ORIGINATOR,
                        ...attributionHeaders(),
                    },
                    signal: controller.signal,
                });
            }
            catch (error) {
                if (signal?.aborted)
                    throw new LlmError('native Codex catalog request was aborted', 'ABORTED');
                if (controller.signal.aborted) {
                    throw new CatalogFetchError('native Codex catalog request timed out', 'CATALOG_TIMEOUT', true, { cause: error });
                }
                throw new CatalogFetchError('native Codex catalog request failed', 'CATALOG_UNAVAILABLE', true, { cause: error });
            }
            throwIfAborted(signal);
            if (!response.ok) {
                const allowsStale = response.status === 408 || response.status === 429 || response.status >= 500;
                const code = response.status === 401
                    ? 'INVALID_CREDENTIAL'
                    : response.status === 403
                        ? 'CATALOG_FORBIDDEN'
                        : 'CATALOG_HTTP_ERROR';
                throw new CatalogFetchError(`native Codex catalog request failed (HTTP ${response.status})`, code, allowsStale);
            }
            let body;
            try {
                body = await boundedResponseText(response);
            }
            catch (error) {
                if (error instanceof CatalogFetchError)
                    throw error;
                if (signal?.aborted)
                    throw new LlmError('native Codex catalog request was aborted', 'ABORTED');
                if (controller.signal.aborted) {
                    throw new CatalogFetchError('native Codex catalog request timed out', 'CATALOG_TIMEOUT', true, { cause: error });
                }
                throw new CatalogFetchError('native Codex catalog response could not be read', 'CATALOG_UNAVAILABLE', true, { cause: error });
            }
            throwIfAborted(signal);
            let payload;
            try {
                payload = JSON.parse(body);
            }
            catch (error) {
                throw new CatalogFetchError('native Codex catalog response was not valid JSON', 'CATALOG_INVALID_RESPONSE', true, { cause: error });
            }
            const entry = {
                fetchedAt: this.now(),
                clientVersion: this.clientVersion,
                accountHash: hash,
                ...nonEmptyString(response.headers.get('etag')) === undefined
                    ? {}
                    : { etag: response.headers.get('etag') },
                models: parseModelsPayload(payload),
            };
            throwIfAborted(signal);
            return entry;
        }
        finally {
            clearTimeout(timeout);
            if (signal !== undefined)
                signal.removeEventListener('abort', abortFromCaller);
        }
    }
}
