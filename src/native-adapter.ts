/** Experimental native Codex adapter with live catalog and HTTP transport delegation. */
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ModelModality,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {
  NativeCodexModel,
  NativeCodexModelCatalog,
} from './catalog.js'

/** Provider route reserved for the package-owned native Codex adapter. */
export const NATIVE_CODEX_PROVIDER = 'openai-codex-native'
export const CODEX_FAST_ALIAS_SUFFIX = '-fast'
export const CODEX_FAST_SERVICE_TIER = 'priority'

function effortName(effort: string): string {
  switch (effort) {
    case 'none': return 'None'
    case 'minimal': return 'Minimal'
    case 'low': return 'Low'
    case 'medium': return 'Medium'
    case 'high': return 'High'
    case 'xhigh': return 'Extra High'
    case 'max': return 'Max'
    case 'ultra': return 'Ultra'
    case 'persistent': return 'Persistent'
    default: return effort
  }
}

function inputModalities(model: NativeCodexModel): readonly ModelModality[] {
  return model.inputModalities.filter(
    (modality): modality is ModelModality => modality === 'text' || modality === 'image',
  )
}

function supportsFast(model: NativeCodexModel): boolean {
  return model.serviceTiers.some(tier => tier.id === CODEX_FAST_SERVICE_TIER)
    || model.additionalSpeedTiers.includes('fast')
}

function fastRoutes(models: readonly NativeCodexModel[]): Map<string, NativeCodexModel> {
  const exact = new Set(models.map(model => model.slug))
  const routes = new Map<string, NativeCodexModel>()
  for (const model of models) {
    const alias = `${model.slug}${CODEX_FAST_ALIAS_SUFFIX}`
    if (supportsFast(model) && !exact.has(alias)) routes.set(alias, model)
  }
  return routes
}

function listModel(
  provider: string, model: NativeCodexModel, fast = false,
): LlmModelInfo {
  const description = model.description
  return {
    provider,
    id: fast ? `${model.slug}${CODEX_FAST_ALIAS_SUFFIX}` : model.slug,
    name: fast ? `${model.displayName} (Fast)` : model.displayName,
    ...description === undefined ? {} : { description },
    inputModalities: inputModalities(model),
  }
}

function resolvedModel(
  provider: string, model: NativeCodexModel, fast = false,
): LlmResolvedModelInfo {
  const info: LlmResolvedModelInfo = {
    ...listModel(provider, model, fast),
    ...model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } },
  }
  const efforts = []
  const seen = new Set<string>()
  for (const level of model.supportedReasoningLevels) {
    if (seen.has(level.effort)) continue
    seen.add(level.effort)
    const id = ReasoningEffortId(level.effort)
    efforts.push({
      id,
      name: effortName(level.effort),
      ...level.description === undefined ? {} : { description: level.description },
    })
  }
  const defaultEffort = model.defaultReasoningLevel !== undefined
      && seen.has(model.defaultReasoningLevel)
    ? ReasoningEffortId(model.defaultReasoningLevel)
    : undefined
  if (efforts.length > 0) {
    info.reasoning = {
      efforts,
      ...defaultEffort === undefined ? {} : { defaultEffort },
    }
  }
  return info
}

/** Request-scoped native Codex transport owned by this package. */
export interface NativeCodexTransportMode {
  serviceTier?: typeof CODEX_FAST_SERVICE_TIER
  publicModel?: string
  authorityHash?: string
  /** Turn-scoped sticky routing state captured from a provider response. */
  turnState?: string
  /** @internal Receives a newly observed bounded turn-state token. */
  captureTurnState?: (state: string) => void
}

export interface NativeCodexTransport {
  stream(options: GenerateOptions, mode?: NativeCodexTransportMode): AsyncIterable<StreamChunk>
}

/** Disable outer step replay: the native transport owns only safe pre-output retries. */
const NATIVE_RETRY_POLICY: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze([]),
  initialDelayMs: 200,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

/** Package-owned DSH adapter with live catalog metadata and native transport delegation. */
export class NativeCodexAdapter extends LlmAdapter {
  constructor(
    private readonly catalog?: NativeCodexModelCatalog,
    private readonly transport?: NativeCodexTransport,
  ) {
    super()
  }

  private assertProvider(provider: string): void {
    if (provider !== NATIVE_CODEX_PROVIDER) {
      throw new LlmError(
        `native Codex adapter does not own provider "${provider}"`,
        'NO_ADAPTER',
      )
    }
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new LlmError('native Codex request was aborted', 'ABORTED')
    }
  }

  providerInfo(provider: string): LlmProviderInfo {
    this.assertProvider(provider)
    return { id: provider, name: 'OpenAI Codex (Native, Experimental)' }
  }

  providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    this.assertProvider(provider)
    return NATIVE_RETRY_POLICY
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertProvider(provider)
    const models = await this.catalog?.list() ?? []
    const aliases = fastRoutes(models)
    return models
      .filter(model => model.visibility === 'list')
      .sort((left, right) => left.priority - right.priority)
      .flatMap(model => {
        const alias = `${model.slug}${CODEX_FAST_ALIAS_SUFFIX}`
        return [
          listModel(provider, model),
          ...aliases.get(alias) === model ? [listModel(provider, model, true)] : [],
        ]
      })
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    this.assertNotAborted(signal)
    this.assertProvider(provider)
    const models = await this.catalog?.list(signal) ?? []
    this.assertNotAborted(signal)
    const exact = models.find(candidate => candidate.slug === model)
    if (exact !== undefined) return resolvedModel(provider, exact)
    const fast = fastRoutes(models).get(model)
    if (fast !== undefined) return resolvedModel(provider, fast, true)
    if (model.endsWith(CODEX_FAST_ALIAS_SUFFIX)) {
      throw new LlmError(
        'native Codex Fast is not advertised for the selected model',
        'FAST_UNSUPPORTED',
      )
    }
    return { provider, id: model, name: model }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.assertNotAborted(options.signal)
    this.assertProvider(options.provider)
    if (this.transport === undefined) {
      throw new LlmError(
        'native Codex transport is not configured',
        'NATIVE_TRANSPORT_NOT_CONFIGURED',
      )
    }
    if (options.model.endsWith(CODEX_FAST_ALIAS_SUFFIX)) {
      const view = this.catalog?.listWithAuthority === undefined
        ? { models: await this.catalog?.list(options.signal) ?? [] }
        : await this.catalog.listWithAuthority(options.signal)
      this.assertNotAborted(options.signal)
      const exact = view.models.find(candidate => candidate.slug === options.model)
      if (exact !== undefined) {
        yield* this.transport.stream(options)
        return
      }
      const fast = fastRoutes(view.models).get(options.model)
      if (fast === undefined) {
        throw new LlmError(
          'native Codex Fast is not advertised for the selected model',
          'FAST_UNSUPPORTED',
        )
      }
      if (view.authorityHash === undefined) {
        throw new LlmError(
          'native Codex Fast capability authority is unavailable',
          'FAST_CAPABILITY_UNAVAILABLE',
        )
      }
      yield* this.transport.stream(
        { ...options, model: fast.slug },
        {
          serviceTier: CODEX_FAST_SERVICE_TIER,
          publicModel: options.model,
          authorityHash: view.authorityHash,
        },
      )
      return
    }
    yield* this.transport.stream(options)
  }
}
