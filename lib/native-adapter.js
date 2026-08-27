/** Experimental native Codex adapter; HTTP transport arrives in M3. */
import { LlmAdapter, LlmError, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
/** Provider route reserved for the package-owned native Codex adapter. */
export const NATIVE_CODEX_PROVIDER = 'openai-codex-native';
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
function listModel(provider, model) {
    const description = model.description;
    return {
        provider,
        id: model.slug,
        name: model.displayName,
        ...description === undefined ? {} : { description },
        inputModalities: inputModalities(model),
    };
}
function resolvedModel(provider, model) {
    const info = {
        ...listModel(provider, model),
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
/** Package-owned DSH adapter with live catalog metadata and an M3 transport boundary. */
export class NativeCodexAdapter extends LlmAdapter {
    catalog;
    constructor(catalog) {
        super();
        this.catalog = catalog;
    }
    assertProvider(provider) {
        if (provider !== NATIVE_CODEX_PROVIDER) {
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
        return { id: provider, name: 'OpenAI Codex (Native, Experimental)' };
    }
    async listModels(provider) {
        this.assertProvider(provider);
        const models = await this.catalog?.list() ?? [];
        return models
            .filter(model => model.visibility === 'list')
            .sort((left, right) => left.priority - right.priority)
            .map(model => listModel(provider, model));
    }
    async resolveModel(provider, model, signal) {
        this.assertNotAborted(signal);
        this.assertProvider(provider);
        const models = await this.catalog?.list(signal) ?? [];
        this.assertNotAborted(signal);
        const match = models.find(candidate => candidate.slug === model);
        return match === undefined
            ? { provider, id: model, name: model }
            : resolvedModel(provider, match);
    }
    async *stream(options) {
        this.assertNotAborted(options.signal);
        this.assertProvider(options.provider);
        throw new LlmError('native Codex transport is not implemented before M3', 'NATIVE_TRANSPORT_NOT_READY');
    }
}
