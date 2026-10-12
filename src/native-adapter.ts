/** Native Codex adapter with live catalog and HTTP/WebSocket transport delegation. */
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmRuntime,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ModelModality,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type {
  NativeCodexModel,
  NativeCodexModelCatalog,
} from './catalog.js'

/** Production provider route owned by the package native Codex adapter after M6 cutover. */
export const CODEX_PROVIDER = 'openai-codex'
/** Compatibility route retained for sessions created during the native preview. */
export const NATIVE_CODEX_PROVIDER = 'openai-codex-native'
const OWNED_CODEX_PROVIDERS = new Set([CODEX_PROVIDER, NATIVE_CODEX_PROVIDER])
const replayOwners = new WeakMap<object, Map<string, NativeCodexAdapter>>()

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Native replay ownership changed.
     * @mode emit
     */
    'codex/replay-owners-updated'(): void
  }
}

/**
 * Snapshot immutable provider groups for a pure projection's replay policy.
 * @param runtime - current LLM service, or undefined before it is available.
 * @returns sorted groups; each group is owned by one native adapter instance.
 */
export function nativeCodexReplayGroups(runtime: LlmRuntime | undefined): readonly (readonly string[])[] {
  if (runtime === undefined) return Object.freeze([])
  const groups = new Map<NativeCodexAdapter, string[]>()
  for (const [provider, adapter] of replayOwners.get(runtimeKey(runtime)) ?? []) {
    const group = groups.get(adapter) ?? []
    group.push(provider)
    groups.set(adapter, group)
  }
  return Object.freeze([...groups.values()].map(group => Object.freeze(group.sort()))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
}

// Cordis returns scope-traced views; use the original service for ownership identity.
function runtimeKey(runtime: LlmRuntime): object {
  return Reflect.get(runtime, symbols.original) ?? runtime
}

/**
 * Register native routes and their replay-pricing ownership in the same Cordis scope.
 * @param ctx - scope owning the native adapter registration.
 * @param providers - canonical and optional compatibility routes for this instance.
 * @param adapter - native adapter that will replay its own continuation state.
 */
export function registerNativeCodexAdapter(
  ctx: Context,
  providers: string[],
  adapter: NativeCodexAdapter,
): void {
  const runtime = ctx.get('llm')
  if (runtime === undefined) throw new Error('native Codex registration requires llm')
  ctx.llm.registerAdapter(providers, adapter)
  ctx.effect(() => {
    let owners = replayOwners.get(runtimeKey(runtime))
    if (owners === undefined) replayOwners.set(runtimeKey(runtime), owners = new Map())
    for (const provider of providers) owners.set(provider, adapter)
    ctx.emit('codex/replay-owners-updated')
    return () => {
      for (const provider of providers) {
        if (owners.get(provider) === adapter) owners.delete(provider)
      }
      ctx.emit('codex/replay-owners-updated')
    }
  })
}

/**
 * Match the runtime's same-adapter ownership rule for native continuation replay.
 * @param runtime - current global LLM service instance.
 * @param sourceProvider - provider that produced the historical assistant message.
 * @param targetProvider - provider preparing the measured request.
 * @returns whether both routes are currently owned by the same native adapter.
 */
export function canReplayNativeCodex(
  runtime: LlmRuntime,
  sourceProvider: string,
  targetProvider: string,
): boolean {
  const owners = replayOwners.get(runtimeKey(runtime))
  const adapter = owners?.get(targetProvider)
  return adapter !== undefined && owners?.get(sourceProvider) === adapter
}
export const CODEX_FAST_ALIAS_SUFFIX = '-fast'
export const CODEX_FAST_SERVICE_TIER = 'priority'
/** Pure network establishment failure; retried without consuming the finite stream budget. */
export const NATIVE_CODEX_CONNECTION_FAILED_CODE = 'NATIVE_CODEX_CONNECTION_FAILED'
/** Retryable only at DSH's durable failed-step boundary after output became visible. */
export const NATIVE_CODEX_STREAM_INTERRUPTED_CODE = 'NATIVE_CODEX_STREAM_INTERRUPTED'

const NATIVE_CODEX_NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTDOWN', 'EHOSTUNREACH',
  'ENETDOWN', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
])

/** Identify only DNS/TCP/socket establishment failures suitable for unbounded recovery. */
export function isNativeCodexConnectionFailure(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const candidate = error as {
    code?: unknown
    message?: unknown
    cause?: unknown
    errors?: unknown
  }
  if (typeof candidate.code === 'string'
    && NATIVE_CODEX_NETWORK_ERROR_CODES.has(candidate.code)) return true
  if (typeof candidate.message === 'string'
    && candidate.message.includes('Opening handshake has timed out')) return true
  if (Array.isArray(candidate.errors)
    && candidate.errors.some(item => isNativeCodexConnectionFailure(item, depth + 1))) return true
  return isNativeCodexConnectionFailure(candidate.cause, depth + 1)
}

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

function responsesLiteMode(
  model: NativeCodexModel | undefined, requestedModel = model?.slug,
): Pick<NativeCodexTransportMode, 'responsesLite'> {
  if (model !== undefined && !model.useResponsesLite) return {}
  // Never downgrade known Lite-only slugs to Standard Responses during catalog outages.
  if (model === undefined && requestedModel !== 'gpt-6-astra'
    && requestedModel !== 'gpt-6-sol' && requestedModel !== 'gpt-6.1-sol') return {}
  return {
    responsesLite: {
      defaultVerbosity: model?.defaultVerbosity ?? 'low',
      ...model?.instructionsTemplate === undefined ? {}
        : { instructionsTemplate: model.instructionsTemplate },
    },
  }
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

/** Match Codex's model-aware mapping from UI reasoning choices to Responses wire values. */
export function nativeCodexWireReasoningEffort(
  effort: string | undefined,
  model?: NativeCodexModel,
): string | undefined {
  if (effort === undefined) return undefined
  if (effort === 'persistent') return 'disabled'
  if (effort !== 'ultra') return effort
  const supported = model?.supportedReasoningLevels ?? []
  const configured = model?.multiAgentReasoningEffort
  if (configured !== undefined && configured !== 'ultra'
    && supported.some(level => level.effort === configured)) return configured
  if (supported.some(level => level.effort === 'max')) return 'max'
  return [...supported].reverse().find(level => level.effort !== 'ultra')?.effort ?? 'medium'
}

function withWireReasoning(
  options: GenerateOptions,
  model?: NativeCodexModel,
): GenerateOptions {
  const explicit = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
  const selected = explicit ?? (model?.useResponsesLite ? model.defaultReasoningLevel : undefined)
  const wire = nativeCodexWireReasoningEffort(selected, model)
  return wire === undefined || wire === explicit
    ? options
    : { ...options, reasoningEffort: ReasoningEffortId(wire) }
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
  /** Enables the model-specific Responses Lite request and routing contract. */
  responsesLite?: { defaultVerbosity?: string; instructionsTemplate?: string }
  publicModel?: string
  authorityHash?: string
  /** Turn-scoped sticky routing state captured from a provider response. */
  turnState?: string
  /** @internal Receives a newly observed bounded turn-state token. */
  captureTurnState?: (state: string) => void
  /** @internal Pins WebSocket reconnects and HTTP fallback to one account. */
  pinnedAccountId?: string
}

export interface NativeCodexTransport {
  stream(options: GenerateOptions, mode?: NativeCodexTransportMode): AsyncIterable<StreamChunk>
}

/**
 * Match Codex's five dropped-stream retries at DSH's durable failed-step boundary.
 * The transports still own only safe pre-output retries; once a chunk is visible,
 * dsh-llm-retry reconstructs a fresh agent turn without persisting failed chunks.
 */
const NATIVE_RETRY_POLICY: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze([
    'EMPTY_RESPONSE',
    NATIVE_CODEX_STREAM_INTERRUPTED_CODE,
  ]),
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
    if (!OWNED_CODEX_PROVIDERS.has(provider)) {
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
    return {
      id: provider,
      name: provider === CODEX_PROVIDER ? 'OpenAI Codex' : 'OpenAI Codex (Native Compatibility)',
    }
  }

  providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    this.assertProvider(provider)
    return NATIVE_RETRY_POLICY
  }

  /**
   * Read model metadata, retrying once when a fetch returned nothing. The catalog
   * caches nothing on failure, so a momentary outage otherwise empties every model
   * list it touches; metadata is advisory and one extra request is cheaper than a
   * provider that disappears from the picker until the next attempt.
   */
  private async catalogModels(signal?: AbortSignal): Promise<readonly NativeCodexModel[]> {
    const first = await this.catalog?.list(signal) ?? []
    if (first.length > 0) return first
    this.assertNotAborted(signal)
    return await this.catalog?.list(signal) ?? []
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertProvider(provider)
    const models = await this.catalogModels()
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
    const models = await this.catalogModels(signal)
    this.assertNotAborted(signal)
    const exact = models.find(candidate => candidate.slug === model)
    if (exact !== undefined) return resolvedModel(provider, exact)
    const fast = fastRoutes(models).get(model)
    if (fast !== undefined) return resolvedModel(provider, fast, true)
    if (model.endsWith(CODEX_FAST_ALIAS_SUFFIX)) {
      const base = model.slice(0, -CODEX_FAST_ALIAS_SUFFIX.length)
      // Only a catalog that knows the base model can answer this negatively.
      // Without any entry for it the metadata is missing rather than negative, and
      // a caller that resolves every listed model (the picker) must not lose the
      // whole provider group to an advisory fetch.
      if (models.some(candidate => candidate.slug === base)) {
        throw new LlmError(
          'native Codex Fast is not advertised for the selected model',
          'FAST_UNSUPPORTED',
        )
      }
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
        yield* this.transport.stream(withWireReasoning(options, exact), responsesLiteMode(exact))
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
        { ...withWireReasoning(options, fast), model: fast.slug },
        {
          serviceTier: CODEX_FAST_SERVICE_TIER,
          publicModel: options.model,
          authorityHash: view.authorityHash,
          ...responsesLiteMode(fast),
        },
      )
      return
    }
    const model = (await this.catalog?.list(options.signal) ?? [])
      .find(candidate => candidate.slug === options.model)
    this.assertNotAborted(options.signal)
    yield* this.transport.stream(
      withWireReasoning(options, model), responsesLiteMode(model, options.model),
    )
  }
}
