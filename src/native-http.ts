/** Native ChatGPT Codex HTTP/SSE transport with safe pre-output retries. */
import { createHash, randomUUID } from 'node:crypto'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  attributionHeaders,
  type ContentBlock,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { nativeCodexAuthorityHash, type NativeCodexCredential } from './catalog.js'
import { nativeCodexEndpoint } from './endpoint.js'
import {
  NATIVE_CODEX_CONNECTION_FAILED_CODE,
  NATIVE_CODEX_STREAM_INTERRUPTED_CODE,
  isNativeCodexConnectionFailure,
  type NativeCodexTransportMode,
} from './native-adapter.js'
import {
  boundedCodexTurnState,
  codexRequestBody,
  codexResponseTurnState,
  streamResponses,
  type ResolvedContentPart,
  type ResolvedMessage,
  type ResolvedToolResultPart,
} from './responses.js'
import { hasNativeCodexReplayKind } from './replay.js'
import {
  parseCodexResponseUsageMetadata,
  publishCodexResponseUsage,
  type CodexResponseUsageCallback,
} from './response-usage.js'
import {
  parseCodexRateLimitEvent,
  parseCodexRateLimitHeaders,
  publishCodexRateLimits,
  type CodexRateLimitCallback,
} from './rate-limits.js'

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_MAX_TRANSIENT_RETRIES = 4
const DEFAULT_INITIAL_RETRY_DELAY_MS = 200
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000
const INITIAL_CONNECTION_RETRY_DELAY_MS = 5_000
const MAX_CONNECTION_RETRY_DELAY_MS = 60_000
const DEFAULT_MAX_REQUEST_BODY_BYTES = 24 * 1024 * 1024
const MAX_ERROR_BODY_BYTES = 64 * 1024

type ImageBlock = Extract<ContentBlock, { type: 'image' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool-result' }>

export interface NativeCodexImageRead {
  data: Uint8Array
}

export interface NativeCodexHttpOptions {
  resolveCredential(signal?: AbortSignal): Promise<NativeCodexCredential>
  recoverCredential?(previous: NativeCodexCredential, signal?: AbortSignal): Promise<boolean>
  readImage?(attachment: ImageBlock['attachment'], signal?: AbortSignal): Promise<NativeCodexImageRead>
  fetch?: typeof fetch
  endpoint?: string
  requestTimeoutMs?: number
  streamIdleTimeoutMs?: number
  maxSseEventBytes?: number
  maxTransientRetries?: number
  initialRetryDelayMs?: number
  maxRetryDelayMs?: number
  maxRequestBodyBytes?: number
  random?: () => number
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  createRequestId?: () => string
  onCompleted?: () => void
  onRateLimits?: CodexRateLimitCallback
  onResponseUsage?: CodexResponseUsageCallback
  warn?: (message: string) => void
}

function aborted(message = 'native Codex request was aborted'): LlmError {
  return new LlmError(message, 'ABORTED')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof LlmError) throw signal.reason
  throw aborted()
}

function fixedFailure(message: string, code: string, options?: ConstructorParameters<typeof LlmError>[2]): LlmError {
  return new LlmError(message, code, options)
}

function safePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw fixedFailure(`native Codex ${name} is invalid`, 'INVALID_CONFIG')
  }
  return resolved
}

function safeRetryCount(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_TRANSIENT_RETRIES
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 10) {
    throw fixedFailure('native Codex retry count is invalid', 'INVALID_CONFIG')
  }
  return resolved
}

function stablePromptCacheKey(sessionId: string): string {
  const bytes = createHash('sha256').update(sessionId).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs)
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const reason = signal?.reason
      reject(reason instanceof LlmError
        ? reason : aborted('native Codex retry wait was aborted'))
    }
    function done(): void {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

interface AttemptWatchdog {
  signal: AbortSignal
  timedOut(): boolean
  beginIdle(): void
  pulse(): void
  stop(): void
}

function attemptWatchdog(parent: AbortSignal | undefined, requestMs: number, idleMs: number): AttemptWatchdog {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let expired = false
  let idle = false
  const expire = (): void => {
    expired = true
    controller.abort()
  }
  const arm = (): void => {
    if (timeout !== undefined) clearTimeout(timeout)
    timeout = setTimeout(expire, idle ? idleMs : requestMs)
  }
  const fromParent = (): void => { controller.abort(parent?.reason) }
  if (parent?.aborted) fromParent()
  else parent?.addEventListener('abort', fromParent, { once: true })
  arm()
  return {
    signal: controller.signal,
    timedOut: () => expired,
    beginIdle: () => { idle = true; arm() },
    pulse: () => { if (idle) arm() },
    stop: () => {
      if (timeout !== undefined) clearTimeout(timeout)
      parent?.removeEventListener('abort', fromParent)
      if (!controller.signal.aborted) controller.abort()
    },
  }
}

async function resolveImage(
  block: ImageBlock,
  options: NativeCodexHttpOptions,
  signal?: AbortSignal,
): Promise<ResolvedContentPart> {
  if (options.readImage === undefined) {
    throw fixedFailure('native Codex image input requires the attachment service', 'UNSUPPORTED')
  }
  throwIfAborted(signal)
  const stored = await options.readImage(block.attachment, signal)
  throwIfAborted(signal)
  if (!(stored.data instanceof Uint8Array) || stored.data.byteLength !== block.attachment.bytes) {
    throw fixedFailure('native Codex attachment bytes failed verification', 'INVALID_ATTACHMENT')
  }
  return {
    type: 'image',
    mediaType: block.attachment.mediaType,
    dataBase64: Buffer.from(stored.data).toString('base64'),
  }
}

async function resolveToolResult(
  block: ToolResultBlock,
  options: NativeCodexHttpOptions,
  signal?: AbortSignal,
): Promise<ResolvedToolResultPart> {
  const content: ResolvedContentPart[] = []
  for (const part of block.content) {
    throwIfAborted(signal)
    if (part.type === 'text') content.push(part)
    else if (part.type === 'image') content.push(await resolveImage(part, options, signal))
    else {
      throw fixedFailure('native Codex tool output contains an unsupported content block', 'UNSUPPORTED')
    }
  }
  return {
    type: 'tool-result',
    toolCallId: block.toolCallId,
    content,
    ...block.isError === undefined ? {} : { isError: block.isError },
  }
}

async function resolveMessages(
  generation: GenerateOptions,
  options: NativeCodexHttpOptions,
): Promise<ResolvedMessage[]> {
  const messages: ResolvedMessage[] = []
  for (const message of generation.messages) {
    const content: ResolvedContentPart[] = []
    const source = message.source
    const sourceKind: unknown = (source as { kind?: unknown } | undefined)?.kind
    const subagentSettlement = message.role === 'user' && sourceKind === 'subagent-settled'
    for (const block of message.content) {
      throwIfAborted(generation.signal)
      switch (block.type) {
        case 'text':
          content.push(block)
          break
        case 'reasoning':
          // DSH may relay an assistant's complete output as user-role context (for
          // example, a background subagent settlement notice). Keep reasoning only
          // where native replay can consume it; never promote relayed reasoning to
          // user input or reject the otherwise valid context message.
          if (message.role === 'assistant') content.push(block)
          break
        case 'image':
          if (message.role !== 'user') {
            throw fixedFailure('native Codex supports image input only in user messages', 'UNSUPPORTED')
          }
          content.push(await resolveImage(block, options, generation.signal))
          break
        case 'tool-call':
          if (message.role === 'assistant') content.push(block)
          else if (!subagentSettlement) {
            throw fixedFailure('native Codex tool calls require assistant messages', 'INVALID_ARGS')
          }
          // A settlement copies the child's assistant output into user-role context.
          // Its tool calls belong to the child and must not become parent wire calls.
          break
        case 'tool-result':
          if (message.role !== 'user') {
            throw fixedFailure('native Codex tool results require user messages', 'INVALID_ARGS')
          }
          content.push(await resolveToolResult(block, options, generation.signal))
          break
        default:
          throw fixedFailure('native Codex request contains an unsupported content block', 'UNSUPPORTED')
      }
    }
    const replaySource = message.role === 'assistant' && source?.kind === 'model'
      && source.replayState !== undefined && hasNativeCodexReplayKind(source.replayState)
      ? { provider: source.provider, model: source.model, replayState: source.replayState }
      : undefined
    messages.push({
      role: message.role,
      content,
      ...(replaySource === undefined ? {} : { replaySource }),
    })
  }
  return messages
}

async function boundedError(
  response: Response, signal?: AbortSignal,
): Promise<{ code?: string; message?: string }> {
  if (response.body === null) return {}
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let cancelled = false
  const onAbort = (): void => {
    cancelled = true
    void reader.cancel(signal?.reason).catch(() => {})
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      if (cancelled) return {}
      const { done, value } = await reader.read()
      if (cancelled) return {}
      if (done) break
      total += value.byteLength
      if (total > MAX_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return {}
      }
      chunks.push(value)
    }
  } catch {
    return {}
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(
      chunk.buffer, chunk.byteOffset, chunk.byteLength,
    )), total).toString('utf8')) as unknown
    if (typeof value !== 'object' || value === null) return {}
    const outer = value as Record<string, unknown>
    const row = typeof outer.error === 'object' && outer.error !== null
      ? outer.error as Record<string, unknown>
      : outer
    return {
      ...typeof row.code === 'string' ? { code: row.code } : {},
      ...typeof row.message === 'string' ? { message: row.message } : {},
    }
  } catch {
    return {}
  }
}

function retryAfterMs(response: Response, maxDelayMs: number): number | undefined {
  const raw = response.headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw)
  const value = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - Date.now()
  return Number.isFinite(value) && value > 0 ? Math.min(value, maxDelayMs) : undefined
}

function errorFacts(
  response: Response,
  maxDelayMs: number,
): ConstructorParameters<typeof LlmError>[2] {
  const providerRetryAfterMs = retryAfterMs(response, maxDelayMs)
  const requestId = response.headers.get('x-request-id')
  return {
    status: response.status,
    ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
    ...requestId === null || requestId.length === 0 || requestId.length > 256
      ? {}
      : { requestId: ProviderRequestId(requestId) },
  }
}

async function httpFailure(
  response: Response, maxDelayMs: number, signal?: AbortSignal,
): Promise<LlmError> {
  const detail = await boundedError(response, signal)
  const facts = errorFacts(response, maxDelayMs)
  const classification = `${detail.code ?? ''} ${detail.message ?? ''}`
  if (response.status === 401 || response.status === 403) {
    return fixedFailure('native Codex rejected the configured credential', 'AUTH', facts)
  }
  if (response.status === 429) {
    if (isQuotaExceededError(classification)) {
      return fixedFailure('native Codex account quota is exhausted', QUOTA_EXCEEDED_CODE, facts)
    }
    return fixedFailure('native Codex request was rate limited', 'RATE_LIMIT', facts)
  }
  if (detail.code === 'context_length_exceeded'
    || detail.code === 'context_window_exceeded'
    || isContextWindowExceededError(classification)) {
    return fixedFailure('native Codex request exceeded the model context window', CONTEXT_WINDOW_EXCEEDED_CODE, facts)
  }
  if (isQuotaExceededError(classification)) {
    return fixedFailure('native Codex account quota is exhausted', QUOTA_EXCEEDED_CODE, facts)
  }
  if (response.status === 408 || response.status === 504) {
    return fixedFailure('native Codex request timed out', 'TIMEOUT', facts)
  }
  if (response.status >= 500) {
    return fixedFailure('native Codex server request failed', 'SERVER', facts)
  }
  return fixedFailure('native Codex request was rejected', 'INVALID_REQUEST', facts)
}

function mappedFailure(error: unknown, watchdog: AttemptWatchdog, parent?: AbortSignal): LlmError {
  if (parent?.aborted) {
    return parent.reason instanceof LlmError ? parent.reason : aborted()
  }
  if (watchdog.timedOut()) return fixedFailure('native Codex request timed out', 'TIMEOUT')
  if (error instanceof LlmError) return error
  return fixedFailure('native Codex transport failed', 'TRANSPORT', { cause: error })
}

function connectionFailure(
  error: unknown, watchdog: AttemptWatchdog, parent?: AbortSignal,
): LlmError | undefined {
  if (parent?.aborted || watchdog.timedOut()) return undefined
  if (error instanceof LlmError && error.code === NATIVE_CODEX_CONNECTION_FAILED_CODE) {
    return error
  }
  if (!isNativeCodexConnectionFailure(error)) return undefined
  return fixedFailure(
    'native Codex HTTP connection failed', NATIVE_CODEX_CONNECTION_FAILED_CODE, { cause: error },
  )
}

function unexpectedRedirect(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const candidate = error as { message?: unknown; cause?: unknown }
  if (candidate.message === 'unexpected redirect') return true
  return unexpectedRedirect(candidate.cause, depth + 1)
}

function retryable(error: LlmError): boolean {
  return ['TRANSPORT', 'SERVER', 'TIMEOUT', 'STREAM_CLOSED'].includes(error.code)
}

function failedStepRetry(error: LlmError): LlmError {
  const failure = error.failure
  const providerRetryAfterMs = failure.providerRetryAfterMs === undefined
    ? undefined : Math.min(failure.providerRetryAfterMs, DEFAULT_MAX_RETRY_DELAY_MS)
  return fixedFailure(
    `native Codex response stream was interrupted: ${error.message}`,
    NATIVE_CODEX_STREAM_INTERRUPTED_CODE,
    {
      cause: error,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
      ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
    },
  )
}

export interface NativeCodexPreparedRequest {
  generation: GenerateOptions
  mode: NativeCodexTransportMode
  request: Record<string, unknown>
  body: string
  routingId: string
  routingHint: string
}

/** HTTP Responses transport. It never retains a credential outside one attempt. */
export class NativeCodexHttpTransport {
  private readonly fetchImpl: typeof fetch
  private readonly endpoint: string
  private readonly requestTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly maxRetries: number
  private readonly initialDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxBodyBytes: number

  constructor(private readonly options: NativeCodexHttpOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.endpoint = nativeCodexEndpoint(options.endpoint ?? CODEX_RESPONSES_URL).toString()
    this.requestTimeoutMs = safePositiveInteger(
      options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'request timeout',
    )
    this.idleTimeoutMs = safePositiveInteger(
      options.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS, 'stream idle timeout',
    )
    this.maxRetries = safeRetryCount(options.maxTransientRetries)
    this.initialDelayMs = safePositiveInteger(
      options.initialRetryDelayMs, DEFAULT_INITIAL_RETRY_DELAY_MS, 'initial retry delay',
    )
    this.maxDelayMs = safePositiveInteger(
      options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS, 'maximum retry delay',
    )
    this.maxBodyBytes = safePositiveInteger(
      options.maxRequestBodyBytes, DEFAULT_MAX_REQUEST_BODY_BYTES, 'request body limit',
    )
  }

  private retryDelay(retry: number, providerDelay?: number): number {
    if (providerDelay !== undefined) return Math.min(providerDelay, this.maxDelayMs)
    const exponential = Math.min(this.initialDelayMs * (2 ** retry), this.maxDelayMs)
    const random = this.options.random?.() ?? Math.random()
    const jitter = 0.9 + Math.max(0, Math.min(1, random)) * 0.2
    return Math.max(1, Math.round(exponential * jitter))
  }

  private async wait(retry: number, error: LlmError, signal?: AbortSignal): Promise<void> {
    const delay = this.retryDelay(retry, error.failure.providerRetryAfterMs)
    await (this.options.sleep ?? sleep)(delay, signal)
  }

  private async waitForConnection(delayMs: number, signal?: AbortSignal): Promise<void> {
    this.options.warn?.(`native Codex network is unavailable; reconnecting in ${delayMs}ms`)
    await (this.options.sleep ?? sleep)(delayMs, signal)
  }

  endpointUrl(): string { return this.endpoint }

  async prepare(
    generation: GenerateOptions, mode: NativeCodexTransportMode = {},
  ): Promise<NativeCodexPreparedRequest> {
    throwIfAborted(generation.signal)
    if (generation.model.length === 0 || generation.model.length > 256
      || /[\r\n\0;]/u.test(generation.model)) {
      throw fixedFailure('native Codex model identity is invalid', 'INVALID_ARGS')
    }
    const messages = await resolveMessages(generation, this.options)
    throwIfAborted(generation.signal)
    const sessionId = generation.sessionId === undefined ? undefined : String(generation.sessionId)
    if (sessionId !== undefined
      && (sessionId.length === 0 || sessionId.length > 256 || /[\r\n\0]/u.test(sessionId))) {
      throw fixedFailure('native Codex session identity is invalid', 'INVALID_ARGS')
    }
    const routingId = sessionId ?? (this.options.createRequestId?.() ?? randomUUID())
    const routingHint = mode.serviceTier === undefined
      ? `model=${generation.model}`
      : `model=${generation.model};tier=${mode.serviceTier}`
    const wireOptions = sessionId === undefined
      ? generation
      : {
          ...generation,
          sessionId: stablePromptCacheKey(sessionId) as NonNullable<GenerateOptions['sessionId']>,
        }
    let request: Record<string, unknown>
    let body: string
    try {
      request = codexRequestBody(wireOptions, messages, mode)
      body = JSON.stringify(request)
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw fixedFailure('native Codex request could not be encoded', 'INVALID_ARGS', { cause: error })
    }
    if (Buffer.byteLength(body) > this.maxBodyBytes) {
      throw fixedFailure('native Codex request exceeded the size limit', 'REQUEST_TOO_LARGE')
    }
    return { generation, mode, request, body, routingId, routingHint }
  }

  async *stream(
    generation: GenerateOptions, mode: NativeCodexTransportMode = {},
  ): AsyncIterable<StreamChunk> {
    const prepared = await this.prepare(generation, mode)
    const { body, routingId, routingHint } = prepared
    let activeTurnState = mode.turnState
    if (activeTurnState !== undefined
      && (activeTurnState.length === 0 || Buffer.byteLength(activeTurnState) > 4096
        || /[\r\n\0]/u.test(activeTurnState))) {
      throw fixedFailure('native Codex turn routing state is invalid', 'INVALID_ARGS')
    }
    let transientRetries = 0
    let connectionRetryDelayMs = INITIAL_CONNECTION_RETRY_DELAY_MS
    let recovered = false
    let pinnedAccountId = mode.pinnedAccountId
    while (true) {
      throwIfAborted(generation.signal)
      const watchdog = attemptWatchdog(
        generation.signal, this.requestTimeoutMs, this.idleTimeoutMs,
      )
      let response: Response
      let credential: NativeCodexCredential
      let fetching = false
      try {
        credential = await this.options.resolveCredential(watchdog.signal)
        throwIfAborted(watchdog.signal)
        if (pinnedAccountId === undefined) pinnedAccountId = credential.accountId
        else if (credential.accountId !== pinnedAccountId) {
          throw fixedFailure('native Codex account changed during request', 'AUTH')
        }
        if (mode.serviceTier !== undefined
          && (mode.authorityHash === undefined
            || nativeCodexAuthorityHash(credential.accountId) !== mode.authorityHash)) {
          throw fixedFailure(
            'native Codex Fast capability authority changed before request',
            'FAST_CAPABILITY_UNAVAILABLE',
          )
        }
        fetching = true
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            'chatgpt-account-id': credential.accountId,
            originator: 'dsh',
            'session-id': routingId,
            'thread-id': routingId,
            'x-client-request-id': routingId,
            'x-codex-routing-hint': routingHint,
            ...(activeTurnState === undefined ? {} : { 'x-codex-turn-state': activeTurnState }),
            ...(generation.purpose === 'compaction' ? { 'x-openai-subagent': 'compact' } : {}),
            ...(mode.responsesLite === undefined
              ? {} : { 'x-openai-internal-codex-responses-lite': 'true' }),
            accept: 'text/event-stream',
            'content-type': 'application/json',
            ...attributionHeaders(),
          },
          body,
          signal: watchdog.signal,
        })
      } catch (error) {
        const redirectRejected = fetching && unexpectedRedirect(error)
        const connection = !redirectRejected
          ? connectionFailure(error, watchdog, generation.signal) : undefined
        const failure = redirectRejected
          ? fixedFailure('native Codex HTTP redirect was rejected', 'INVALID_REQUEST', { cause: error })
          : connection ?? mappedFailure(error, watchdog, generation.signal)
        watchdog.stop()
        if (connection !== undefined) {
          await this.waitForConnection(connectionRetryDelayMs, generation.signal)
          connectionRetryDelayMs = Math.min(
            connectionRetryDelayMs * 2, MAX_CONNECTION_RETRY_DELAY_MS,
          )
          continue
        }
        if (retryable(failure) && transientRetries < this.maxRetries) {
          await this.wait(transientRetries++, failure, generation.signal)
          continue
        }
        throw failure
      }

      publishCodexRateLimits(
        credential.accountId,
        parseCodexRateLimitHeaders(response.headers),
        this.options.onRateLimits,
        this.options.warn,
      )
      if (activeTurnState === undefined) {
        const headerTurnState = boundedCodexTurnState(response.headers.get('x-codex-turn-state'))
        if (headerTurnState !== undefined) {
          activeTurnState = headerTurnState
          mode.captureTurnState?.(headerTurnState)
        }
      }
      if (response.status === 401 && !recovered && this.options.recoverCredential !== undefined) {
        try {
          await response.body?.cancel(watchdog.signal.reason)
          const changed = await this.options.recoverCredential(credential, watchdog.signal)
          recovered = true
          watchdog.stop()
          if (changed) continue
          throw fixedFailure(
            'native Codex rejected the configured credential',
            'AUTH',
            errorFacts(response, this.maxDelayMs),
          )
        } catch (error) {
          const connection = connectionFailure(error, watchdog, generation.signal)
          const failure = connection ?? mappedFailure(error, watchdog, generation.signal)
          watchdog.stop()
          if (connection !== undefined) {
            await this.waitForConnection(connectionRetryDelayMs, generation.signal)
            connectionRetryDelayMs = Math.min(
              connectionRetryDelayMs * 2, MAX_CONNECTION_RETRY_DELAY_MS,
            )
            continue
          }
          throw failure
        }
      }
      if (!response.ok) {
        let failure = await httpFailure(response, this.maxDelayMs, watchdog.signal)
        if (generation.signal?.aborted || watchdog.timedOut()) {
          failure = mappedFailure(failure, watchdog, generation.signal)
        }
        watchdog.stop()
        if (retryable(failure) && transientRetries < this.maxRetries) {
          await this.wait(transientRetries++, failure, generation.signal)
          continue
        }
        throw failure
      }
      if (response.body === null) {
        watchdog.stop()
        throw fixedFailure('native Codex returned no response stream', EMPTY_RESPONSE_CODE)
      }

      watchdog.beginIdle()
      let emitted = false
      let completed = false
      try {
        for await (const chunk of streamResponses(response.body, {
          signal: watchdog.signal,
          onActivity: watchdog.pulse,
          ...this.options.maxSseEventBytes === undefined
            ? {}
            : { maxEventBytes: this.options.maxSseEventBytes },
          onMalformedEvent: () => {
            this.options.warn?.('native Codex ignored a malformed SSE event')
          },
          onEvent: (event) => {
            publishCodexResponseUsage(
              credential.accountId,
              parseCodexResponseUsageMetadata(event),
              this.options.onResponseUsage,
              this.options.warn,
            )
            const eventRateLimits = parseCodexRateLimitEvent(event)
            publishCodexRateLimits(
              credential.accountId,
              eventRateLimits === undefined ? [] : [eventRateLimits],
              this.options.onRateLimits,
              this.options.warn,
            )
            const rawEvent = event as unknown as Record<string, unknown>
            publishCodexRateLimits(
              credential.accountId,
              parseCodexRateLimitHeaders(
                typeof rawEvent.headers === 'object' && rawEvent.headers !== null
                  ? rawEvent.headers as Record<string, unknown> : undefined,
              ),
              this.options.onRateLimits,
              this.options.warn,
            )
            const nextTurnState = codexResponseTurnState(event)
            if (activeTurnState === undefined && nextTurnState !== undefined) {
              activeTurnState = nextTurnState
              mode.captureTurnState?.(nextTurnState)
            }
          },
          replayContext: {
            provider: generation.provider,
            model: mode.publicModel ?? generation.model,
          },
        })) {
          emitted = true
          if (chunk.type === 'finish'
            && ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason.kind)) completed = true
          yield chunk
        }
        if (completed && this.options.onCompleted !== undefined) {
          try { this.options.onCompleted() } catch {
            this.options.warn?.('native Codex usage refresh could not be scheduled')
          }
        }
        return
      } catch (error) {
        const failure = mappedFailure(error, watchdog, generation.signal)
        if (!emitted && retryable(failure) && transientRetries < this.maxRetries) {
          await this.wait(transientRetries++, failure, generation.signal)
          continue
        }
        if (emitted && retryable(failure)) throw failedStepRetry(failure)
        throw failure
      } finally {
        watchdog.stop()
      }
    }
  }
}
