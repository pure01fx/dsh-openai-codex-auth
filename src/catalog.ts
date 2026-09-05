/** Native Codex model discovery, validation, and account-partitioned caching. */
import { createHash } from 'node:crypto'
import { nativeCodexEndpoint } from './endpoint.js'
import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import { CODEX_CLIENT_VERSION } from './upstream.js'

export { CODEX_CLIENT_VERSION } from './upstream.js'
export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
export const CODEX_CATALOG_CACHE_TTL_MS = 5 * 60_000
const CODEX_CATALOG_MAX_STALE_MS = 7 * 24 * 60 * 60_000
const CODEX_CATALOG_TIMEOUT_MS = 5_000
const MAX_CATALOG_BODY_LENGTH = 2 * 1024 * 1024
const ORIGINATOR = 'dsh'

/** One request-scoped credential for native Codex backend calls. */
export interface NativeCodexCredential {
  accessToken: string
  accountId: string
}

/** Resolve current native Codex authority without retaining it across operations. */
export type NativeCodexCredentialResolver = (
  signal?: AbortSignal,
) => Promise<NativeCodexCredential>

export interface NativeCodexReasoningLevel {
  effort: string
  description?: string
}

export interface NativeCodexServiceTier {
  id: string
  name?: string
  description?: string
}

/** Validated subset of codex-rs ModelInfo used by DSH metadata and later transport milestones. */
export interface NativeCodexModel {
  slug: string
  displayName: string
  description?: string
  defaultReasoningLevel?: string
  supportedReasoningLevels: readonly NativeCodexReasoningLevel[]
  multiAgentReasoningEffort?: string
  visibility: string
  supportedInApi: boolean
  priority: number
  additionalSpeedTiers: readonly string[]
  serviceTiers: readonly NativeCodexServiceTier[]
  defaultServiceTier?: string
  /** Requires the model-specific Responses Lite wire contract, not Standard Responses. */
  useResponsesLite?: boolean
  /** Catalog-provided defaults needed to construct the model-specific request. */
  defaultVerbosity?: string
  instructionsTemplate?: string
  contextWindow?: number
  inputModalities: readonly string[]
}

export interface NativeCodexCatalogView {
  models: readonly NativeCodexModel[]
  authorityHash?: string
}

/** Narrow catalog seam consumed by the adapter and injectable in tests. */
export interface NativeCodexModelCatalog {
  list(signal?: AbortSignal): Promise<readonly NativeCodexModel[]>
  listWithAuthority?(signal?: AbortSignal): Promise<NativeCodexCatalogView>
  etag(): string | undefined
}

interface CatalogSnapshot {
  fetchedAt: number
  clientVersion: string
  accountHash: string
  etag?: string
  models: readonly NativeCodexModel[]
}

export interface NativeCodexCatalogOptions {
  resolveCredential: NativeCodexCredentialResolver
  endpoint?: string
  clientVersion?: string
  cacheTtlMs?: number
  maxStaleMs?: number
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
  warn?: (message: string) => void
}

class CatalogFetchError extends LlmError {
  constructor(
    message: string,
    code: string,
    readonly allowsStale: boolean,
    options?: ErrorOptions,
  ) {
    super(message, code, options)
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LlmError('native Codex catalog request was aborted', 'ABORTED')
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(new LlmError('native Codex catalog request was aborted', 'ABORTED'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function invalidCatalog(message: string): CatalogFetchError {
  return new CatalogFetchError(message, 'CATALOG_INVALID_RESPONSE', true)
}

function strictStringList(value: unknown, fallback: readonly string[] = []): readonly string[] | undefined {
  if (value === undefined) return fallback
  if (!Array.isArray(value)
    || !value.every(item => typeof item === 'string' && item.length > 0)) return undefined
  return value
}

function parseReasoningLevels(value: unknown): readonly NativeCodexReasoningLevel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const levels: NativeCodexReasoningLevel[] = []
  for (const item of value) {
    const row = record(item)
    if (row === undefined) return undefined
    const effort = nonEmptyString(row?.effort)
    const description = nonEmptyString(row?.description)
    if (effort === undefined || description === undefined) return undefined
    levels.push({ effort, description })
  }
  return levels
}

function parseServiceTiers(value: unknown): readonly NativeCodexServiceTier[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const tiers: NativeCodexServiceTier[] = []
  for (const item of value) {
    const row = record(item)
    if (row === undefined) return undefined
    const id = nonEmptyString(row?.id)
    const name = nonEmptyString(row?.name)
    const description = nonEmptyString(row?.description)
    if (id === undefined || name === undefined || description === undefined) return undefined
    tiers.push({ id, name, description })
  }
  return tiers
}

async function boundedResponseText(response: Response): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_CATALOG_BODY_LENGTH) {
        await reader.cancel()
        throw new CatalogFetchError(
          'native Codex catalog response exceeded the size limit',
          'CATALOG_INVALID_RESPONSE',
          true,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(
    chunk.buffer,
    chunk.byteOffset,
    chunk.byteLength,
  )), total).toString('utf8')
}

function parseModel(value: unknown): NativeCodexModel {
  const row = record(value)
  if (row === undefined) throw invalidCatalog('native Codex catalog contained a non-object model entry')
  const slug = nonEmptyString(row?.slug)
  const displayName = nonEmptyString(row?.display_name)
  const reasoning = parseReasoningLevels(row?.supported_reasoning_levels)
  const visibility = row?.visibility
  const priority = row?.priority
  const additionalSpeedTiers = strictStringList(row?.additional_speed_tiers)
  const serviceTiers = parseServiceTiers(row?.service_tiers)
  const inputModalities = strictStringList(row?.input_modalities, ['text', 'image'])
  const useResponsesLite = row?.use_responses_lite ?? false
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
    || typeof useResponsesLite !== 'boolean'
    || inputModalities === undefined
    || !inputModalities.every(value => ['text', 'image', 'audio'].includes(value))) {
    throw invalidCatalog('native Codex catalog contained an invalid model entry')
  }
  if (row.description !== undefined && row.description !== null && typeof row.description !== 'string') {
    throw invalidCatalog('native Codex catalog contained an invalid model description')
  }
  if (row.default_reasoning_level !== undefined
    && row.default_reasoning_level !== null
    && nonEmptyString(row.default_reasoning_level) === undefined) {
    throw invalidCatalog('native Codex catalog contained an invalid default reasoning level')
  }
  if (row.default_service_tier !== undefined
    && row.default_service_tier !== null
    && nonEmptyString(row.default_service_tier) === undefined) {
    throw invalidCatalog('native Codex catalog contained an invalid default service tier')
  }
  if (row.multi_agent_reasoning_effort !== undefined
    && row.multi_agent_reasoning_effort !== null
    && nonEmptyString(row.multi_agent_reasoning_effort) === undefined) {
    throw invalidCatalog('native Codex catalog contained an invalid multi-agent reasoning effort')
  }
  if (row.default_verbosity !== undefined && row.default_verbosity !== null
    && nonEmptyString(row.default_verbosity) === undefined) {
    throw invalidCatalog('native Codex catalog contained an invalid default verbosity')
  }
  const modelMessages = row.model_messages === undefined || row.model_messages === null
    ? undefined : record(row.model_messages)
  if ((row.model_messages !== undefined && row.model_messages !== null && modelMessages === undefined)
    || (modelMessages?.instructions_template !== undefined
      && modelMessages.instructions_template !== null
      && nonEmptyString(modelMessages.instructions_template) === undefined)) {
    throw invalidCatalog('native Codex catalog contained invalid model instructions')
  }
  for (const key of ['context_window', 'max_context_window'] as const) {
    if (row[key] !== undefined && row[key] !== null && positiveNumber(row[key]) === undefined) {
      throw invalidCatalog('native Codex catalog contained an invalid context window')
    }
  }
  const description = nonEmptyString(row.description)
  const defaultReasoningLevel = nonEmptyString(row.default_reasoning_level)
  const multiAgentReasoningEffort = nonEmptyString(row.multi_agent_reasoning_effort)
  const defaultServiceTier = nonEmptyString(row.default_service_tier)
  const defaultVerbosity = nonEmptyString(row.default_verbosity)
  const instructionsTemplate = nonEmptyString(modelMessages?.instructions_template)
  const contextWindow = positiveNumber(row.context_window) ?? positiveNumber(row.max_context_window)
  return {
    slug,
    displayName,
    ...description === undefined ? {} : { description },
    ...defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel },
    supportedReasoningLevels: reasoning,
    ...multiAgentReasoningEffort === undefined ? {} : { multiAgentReasoningEffort },
    visibility: visibility as string,
    supportedInApi: row.supported_in_api,
    priority,
    additionalSpeedTiers,
    serviceTiers,
    ...defaultServiceTier === undefined ? {} : { defaultServiceTier },
    useResponsesLite,
    ...defaultVerbosity === undefined ? {} : { defaultVerbosity },
    ...instructionsTemplate === undefined ? {} : { instructionsTemplate },
    ...contextWindow === undefined ? {} : { contextWindow },
    inputModalities,
  }
}

function parseModelsPayload(value: unknown): readonly NativeCodexModel[] {
  const rows = record(value)?.models
  if (!Array.isArray(rows)) throw invalidCatalog('native Codex catalog response has no models array')
  if (rows.length === 0) {
    throw new CatalogFetchError(
      'native Codex catalog response contained no usable models',
      'CATALOG_EMPTY',
      true,
    )
  }
  const models = rows.map(parseModel)
  const slugs = new Set(models.map(model => model.slug))
  if (slugs.size !== models.length) throw invalidCatalog('native Codex catalog contained duplicate model ids')
  if (!models.some(model => model.visibility === 'list')) {
    throw new CatalogFetchError(
      'native Codex catalog response contained no picker-visible models',
      'CATALOG_EMPTY',
      true,
    )
  }
  return models
}

export function nativeCodexAuthorityHash(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex')
}

/** Codex-compatible live catalog with bounded stale fallback and no credential retention. */
export class NativeCodexCatalog implements NativeCodexModelCatalog {
  private readonly endpoint: string
  private readonly clientVersion: string
  private readonly cacheTtlMs: number
  private readonly maxStaleMs: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private snapshot: CatalogSnapshot | undefined
  private readonly refreshes = new Map<string, Promise<CatalogSnapshot>>()
  private currentEtag: string | undefined

  constructor(private readonly options: NativeCodexCatalogOptions) {
    this.endpoint = nativeCodexEndpoint(options.endpoint ?? CODEX_MODELS_URL).toString()
    this.clientVersion = options.clientVersion ?? CODEX_CLIENT_VERSION
    this.cacheTtlMs = options.cacheTtlMs ?? CODEX_CATALOG_CACHE_TTL_MS
    this.maxStaleMs = options.maxStaleMs ?? CODEX_CATALOG_MAX_STALE_MS
    this.timeoutMs = options.timeoutMs ?? CODEX_CATALOG_TIMEOUT_MS
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  etag(): string | undefined {
    return this.currentEtag
  }

  async list(signal?: AbortSignal): Promise<readonly NativeCodexModel[]> {
    return (await this.listWithAuthority(signal)).models
  }

  async listWithAuthority(signal?: AbortSignal): Promise<NativeCodexCatalogView> {
    throwIfAborted(signal)
    this.currentEtag = undefined
    let credential: NativeCodexCredential
    try {
      credential = await this.options.resolveCredential(signal)
    } catch (error) {
      if (error instanceof LlmError && error.code === 'ABORTED') throw error
      if (!(error instanceof LlmError) || error.code !== 'MISSING_CREDENTIAL') {
        this.options.warn?.('native Codex credential is unavailable; model metadata is advisory')
      }
      return { models: [] }
    }
    throwIfAborted(signal)
    const hash = nativeCodexAuthorityHash(credential.accountId)
    const cached = this.snapshot?.clientVersion === this.clientVersion
        && this.snapshot.accountHash === hash
      ? this.snapshot
      : undefined
    throwIfAborted(signal)
    const age = cached === undefined ? Number.POSITIVE_INFINITY : this.now() - cached.fetchedAt
    if (cached !== undefined && age >= 0 && age <= this.cacheTtlMs) {
      this.currentEtag = cached.etag
      return { models: cached.models, authorityHash: hash }
    }
    try {
      let refresh = this.refreshes.get(hash)
      if (refresh === undefined) {
        const started = this.fetchCatalog(credential, hash)
          .then((fresh) => {
            this.snapshot = fresh
            return fresh
          })
          .finally(() => {
            if (this.refreshes.get(hash) === started) this.refreshes.delete(hash)
          })
        refresh = started
        this.refreshes.set(hash, refresh)
      }
      const fresh = await awaitWithSignal(refresh, signal)
      this.currentEtag = fresh.etag
      return { models: fresh.models, authorityHash: hash }
    } catch (error) {
      if (error instanceof LlmError && error.code === 'ABORTED') throw error
      if (error instanceof CatalogFetchError
        && error.allowsStale
        && cached !== undefined
        && age >= 0
        && age <= this.maxStaleMs) {
        this.currentEtag = cached.etag
        this.options.warn?.(`native Codex catalog refresh failed (${error.code}); using bounded stale cache`)
        return { models: cached.models, authorityHash: hash }
      }
      const code = error instanceof LlmError ? error.code : 'UNKNOWN'
      this.options.warn?.(`native Codex catalog refresh failed (${code}); model metadata is advisory`)
      return { models: [], authorityHash: hash }
    }
  }

  private async fetchCatalog(
    credential: NativeCodexCredential,
    hash: string,
    signal?: AbortSignal,
  ): Promise<CatalogSnapshot> {
    const controller = new AbortController()
    const abortFromCaller = (): void => { controller.abort(signal?.reason) }
    if (signal !== undefined) signal.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(() => { controller.abort(new Error('catalog timeout')) }, this.timeoutMs)
    try {
      throwIfAborted(signal)
      const url = new URL(this.endpoint)
      url.searchParams.set('client_version', this.clientVersion)
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            'chatgpt-account-id': credential.accountId,
            originator: ORIGINATOR,
            ...attributionHeaders(),
          },
          signal: controller.signal,
        })
      } catch (error) {
        if (signal?.aborted) throw new LlmError('native Codex catalog request was aborted', 'ABORTED')
        if (controller.signal.aborted) {
          throw new CatalogFetchError(
            'native Codex catalog request timed out',
            'CATALOG_TIMEOUT',
            true,
            { cause: error },
          )
        }
        throw new CatalogFetchError(
          'native Codex catalog request failed',
          'CATALOG_UNAVAILABLE',
          true,
          { cause: error },
        )
      }
      throwIfAborted(signal)
      if (!response.ok) {
        const allowsStale = response.status === 408 || response.status === 429 || response.status >= 500
        const code = response.status === 401
          ? 'INVALID_CREDENTIAL'
          : response.status === 403
            ? 'CATALOG_FORBIDDEN'
            : 'CATALOG_HTTP_ERROR'
        throw new CatalogFetchError(
          `native Codex catalog request failed (HTTP ${response.status})`,
          code,
          allowsStale,
        )
      }
      let body: string
      try {
        body = await boundedResponseText(response)
      } catch (error) {
        if (error instanceof CatalogFetchError) throw error
        if (signal?.aborted) throw new LlmError('native Codex catalog request was aborted', 'ABORTED')
        if (controller.signal.aborted) {
          throw new CatalogFetchError(
            'native Codex catalog request timed out',
            'CATALOG_TIMEOUT',
            true,
            { cause: error },
          )
        }
        throw new CatalogFetchError(
          'native Codex catalog response could not be read',
          'CATALOG_UNAVAILABLE',
          true,
          { cause: error },
        )
      }
      throwIfAborted(signal)
      let payload: unknown
      try {
        payload = JSON.parse(body) as unknown
      } catch (error) {
        throw new CatalogFetchError(
          'native Codex catalog response was not valid JSON',
          'CATALOG_INVALID_RESPONSE',
          true,
          { cause: error },
        )
      }
      const entry: CatalogSnapshot = {
        fetchedAt: this.now(),
        clientVersion: this.clientVersion,
        accountHash: hash,
        ...nonEmptyString(response.headers.get('etag')) === undefined
          ? {}
          : { etag: response.headers.get('etag') as string },
        models: parseModelsPayload(payload),
      }
      throwIfAborted(signal)
      return entry
    } finally {
      clearTimeout(timeout)
      if (signal !== undefined) signal.removeEventListener('abort', abortFromCaller)
    }
  }
}
