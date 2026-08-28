/** Native Codex adapter with live catalog and HTTP/WebSocket transport delegation. */
import { LlmAdapter, LlmError, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
/** Production provider route owned by the package native Codex adapter after M6 cutover. */
export const CODEX_PROVIDER = 'openai-codex';
/** Compatibility route retained for sessions created during the native preview. */
export const NATIVE_CODEX_PROVIDER = 'openai-codex-native';
const OWNED_CODEX_PROVIDERS = new Set([CODEX_PROVIDER, NATIVE_CODEX_PROVIDER]);
export const CODEX_FAST_ALIAS_SUFFIX = '-fast';
export const CODEX_FAST_SERVICE_TIER = 'priority';
/** Pure network establishment failure; retried without consuming the finite stream budget. */
export const NATIVE_CODEX_CONNECTION_FAILED_CODE = 'NATIVE_CODEX_CONNECTION_FAILED';
/** Retryable only at DSH's durable failed-step boundary after output became visible. */
export const NATIVE_CODEX_STREAM_INTERRUPTED_CODE = 'NATIVE_CODEX_STREAM_INTERRUPTED';
const NATIVE_CODEX_NETWORK_ERROR_CODES = new Set([
    'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTDOWN', 'EHOSTUNREACH',
    'ENETDOWN', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
/** Identify only DNS/TCP/socket establishment failures suitable for unbounded recovery. */
export function isNativeCodexConnectionFailure(error, depth = 0) {
    if (depth > 4 || typeof error !== 'object' || error === null)
        return false;
    const candidate = error;
    if (typeof candidate.code === 'string'
        && NATIVE_CODEX_NETWORK_ERROR_CODES.has(candidate.code))
        return true;
    if (typeof candidate.message === 'string'
        && candidate.message.includes('Opening handshake has timed out'))
        return true;
    if (Array.isArray(candidate.errors)
        && candidate.errors.some(item => isNativeCodexConnectionFailure(item, depth + 1)))
        return true;
    return isNativeCodexConnectionFailure(candidate.cause, depth + 1);
}
function effortName(effort) {
    switch (effort) {
        case 'none': return 'None';
        case 'minimal': return 'Minimal';
        case 'low': return 'Low';
        case 'medium': return 'Medium';
        case 'high': return 'High';
        case 'xhigh': return 'Extra High';
        case 'max': return 'Max';
        case 'ultra': return 'Ultra';
        case 'persistent': return 'Persistent';
        default: return effort;
    }
}
function inputModalities(model) {
    return model.inputModalities.filter((modality) => modality === 'text' || modality === 'image');
}
function supportsFast(model) {
    return model.serviceTiers.some(tier => tier.id === CODEX_FAST_SERVICE_TIER)
        || model.additionalSpeedTiers.includes('fast');
}
function fastRoutes(models) {
    const exact = new Set(models.map(model => model.slug));
    const routes = new Map();
    for (const model of models) {
        const alias = `${model.slug}${CODEX_FAST_ALIAS_SUFFIX}`;
        if (supportsFast(model) && !exact.has(alias))
            routes.set(alias, model);
    }
    return routes;
}
/** Match Codex's model-aware mapping from UI reasoning choices to Responses wire values. */
export function nativeCodexWireReasoningEffort(effort, model) {
    if (effort === undefined)
        return undefined;
    if (effort === 'persistent')
        return 'disabled';
    if (effort !== 'ultra')
        return effort;
    const supported = model?.supportedReasoningLevels ?? [];
    const configured = model?.multiAgentReasoningEffort;
    if (configured !== undefined && configured !== 'ultra'
        && supported.some(level => level.effort === configured))
        return configured;
    if (supported.some(level => level.effort === 'max'))
        return 'max';
    return [...supported].reverse().find(level => level.effort !== 'ultra')?.effort ?? 'medium';
}
function withWireReasoning(options, model) {
    const selected = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort);
    const wire = nativeCodexWireReasoningEffort(selected, model);
    return wire === undefined || wire === selected
        ? options
        : { ...options, reasoningEffort: ReasoningEffortId(wire) };
}
function listModel(provider, model, fast = false) {
    const description = model.description;
    return {
        provider,
        id: fast ? `${model.slug}${CODEX_FAST_ALIAS_SUFFIX}` : model.slug,
        name: fast ? `${model.displayName} (Fast)` : model.displayName,
        ...description === undefined ? {} : { description },
        inputModalities: inputModalities(model),
    };
}
function resolvedModel(provider, model, fast = false) {
    const info = {
        ...listModel(provider, model, fast),
        ...model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } },
    };
    const efforts = [];
    const seen = new Set();
    for (const level of model.supportedReasoningLevels) {
        if (seen.has(level.effort))
            continue;
        seen.add(level.effort);
        const id = ReasoningEffortId(level.effort);
        efforts.push({
            id,
            name: effortName(level.effort),
            ...level.description === undefined ? {} : { description: level.description },
        });
    }
    const defaultEffort = model.defaultReasoningLevel !== undefined
        && seen.has(model.defaultReasoningLevel)
        ? ReasoningEffortId(model.defaultReasoningLevel)
        : undefined;
    if (efforts.length > 0) {
        info.reasoning = {
            efforts,
            ...defaultEffort === undefined ? {} : { defaultEffort },
        };
    }
    return info;
}
/**
 * Match Codex's five dropped-stream retries at DSH's durable failed-step boundary.
 * The transports still own only safe pre-output retries; once a chunk is visible,
 * dsh-llm-retry reconstructs a fresh agent turn without persisting failed chunks.
 */
const NATIVE_RETRY_POLICY = Object.freeze({
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: Object.freeze([
        'EMPTY_RESPONSE',
        NATIVE_CODEX_STREAM_INTERRUPTED_CODE,
    ]),
    initialDelayMs: 200,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
});
/** Package-owned DSH adapter with live catalog metadata and native transport delegation. */
export class NativeCodexAdapter extends LlmAdapter {
    catalog;
    transport;
    constructor(catalog, transport) {
        super();
        this.catalog = catalog;
        this.transport = transport;
    }
    assertProvider(provider) {
        if (!OWNED_CODEX_PROVIDERS.has(provider)) {
            throw new LlmError(`native Codex adapter does not own provider "${provider}"`, 'NO_ADAPTER');
        }
    }
    assertNotAborted(signal) {
        if (signal?.aborted) {
            throw new LlmError('native Codex request was aborted', 'ABORTED');
        }
    }
    providerInfo(provider) {
        this.assertProvider(provider);
        return {
            id: provider,
            name: provider === CODEX_PROVIDER ? 'OpenAI Codex' : 'OpenAI Codex (Native Compatibility)',
        };
    }
    providerRetryPolicy(provider) {
        this.assertProvider(provider);
        return NATIVE_RETRY_POLICY;
    }
    async listModels(provider) {
        this.assertProvider(provider);
        const models = await this.catalog?.list() ?? [];
        const aliases = fastRoutes(models);
        return models
            .filter(model => model.visibility === 'list')
            .sort((left, right) => left.priority - right.priority)
            .flatMap(model => {
            const alias = `${model.slug}${CODEX_FAST_ALIAS_SUFFIX}`;
            return [
                listModel(provider, model),
                ...aliases.get(alias) === model ? [listModel(provider, model, true)] : [],
            ];
        });
    }
    async resolveModel(provider, model, signal) {
        this.assertNotAborted(signal);
        this.assertProvider(provider);
        const models = await this.catalog?.list(signal) ?? [];
        this.assertNotAborted(signal);
        const exact = models.find(candidate => candidate.slug === model);
        if (exact !== undefined)
            return resolvedModel(provider, exact);
        const fast = fastRoutes(models).get(model);
        if (fast !== undefined)
            return resolvedModel(provider, fast, true);
        if (model.endsWith(CODEX_FAST_ALIAS_SUFFIX)) {
            throw new LlmError('native Codex Fast is not advertised for the selected model', 'FAST_UNSUPPORTED');
        }
        return { provider, id: model, name: model };
    }
    async *stream(options) {
        this.assertNotAborted(options.signal);
        this.assertProvider(options.provider);
        if (this.transport === undefined) {
            throw new LlmError('native Codex transport is not configured', 'NATIVE_TRANSPORT_NOT_CONFIGURED');
        }
        if (options.model.endsWith(CODEX_FAST_ALIAS_SUFFIX)) {
            const view = this.catalog?.listWithAuthority === undefined
                ? { models: await this.catalog?.list(options.signal) ?? [] }
                : await this.catalog.listWithAuthority(options.signal);
            this.assertNotAborted(options.signal);
            const exact = view.models.find(candidate => candidate.slug === options.model);
            if (exact !== undefined) {
                yield* this.transport.stream(withWireReasoning(options, exact));
                return;
            }
            const fast = fastRoutes(view.models).get(options.model);
            if (fast === undefined) {
                throw new LlmError('native Codex Fast is not advertised for the selected model', 'FAST_UNSUPPORTED');
            }
            if (view.authorityHash === undefined) {
                throw new LlmError('native Codex Fast capability authority is unavailable', 'FAST_CAPABILITY_UNAVAILABLE');
            }
            yield* this.transport.stream({ ...withWireReasoning(options, fast), model: fast.slug }, {
                serviceTier: CODEX_FAST_SERVICE_TIER,
                publicModel: options.model,
                authorityHash: view.authorityHash,
            });
            return;
        }
        const selectedEffort = options.reasoningEffort === undefined
            ? undefined : String(options.reasoningEffort);
        const model = selectedEffort === 'ultra'
            ? (await this.catalog?.list(options.signal) ?? [])
                .find(candidate => candidate.slug === options.model)
            : undefined;
        this.assertNotAborted(options.signal);
        yield* this.transport.stream(withWireReasoning(options, model));
    }
}
