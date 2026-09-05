/** Pure DSH-to-Codex Responses request and stream translation. */
import { createHash } from 'node:crypto'
import {
  CallId, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE,
  isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE,
  type ContentBlock, type GenerateOptions, type StreamChunk, type TokenUsage, type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { parseSse, type ParseSseOptions } from './sse.js'
import {
  NativeCodexReplayCapture,
  replayAssistantInput,
  replayableItemId,
  type NativeCodexReplaySource,
} from './replay.js'

export const DEFAULT_CODEX_INSTRUCTIONS = 'You are Codex, an AI coding agent. Help the user with software engineering tasks.'
const CALL_ID_MAX_LENGTH = 64
const CALL_ID_PREFIX = 'call_'
const MAX_RETAINED_RESPONSE_BYTES = 64 * 1024 * 1024
const UUID_NAMESPACE_OID = Buffer.from('6ba7b8129dad11d180b400c04fd430c8', 'hex')

function uuidV5(namespace: Uint8Array, name: string): string {
  const bytes = createHash('sha1').update(namespace).update(name).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function uuidBytes(value: string): Buffer { return Buffer.from(value.replaceAll('-', ''), 'hex') }

export interface ResolvedImagePart { type: 'image'; mediaType: string; dataBase64: string }
export interface ResolvedToolResultPart {
  type: 'tool-result'
  toolCallId: CallId
  content: readonly ResolvedContentPart[]
  isError?: boolean
}
export type ResolvedContentPart = Exclude<ContentBlock, { type: 'image' | 'tool-result' }>
  | ResolvedImagePart | ResolvedToolResultPart
export interface ResolvedMessage {
  role: 'system' | 'user' | 'assistant'
  content: readonly ResolvedContentPart[]
  replaySource?: NativeCodexReplaySource
}
export interface ResponsesRequestInput { instructions?: string; input: Record<string, unknown>[] }

function fixedError(message: string, code: string): LlmError { return new LlmError(message, code) }

function imageItem(image: ResolvedImagePart): Record<string, unknown> {
  if (!/^image[/][a-z0-9.+-]+$/i.test(image.mediaType) || image.dataBase64.length === 0) {
    throw fixedError('native Codex request contains invalid resolved image data', 'MALFORMED_REQUEST')
  }
  return { type: 'input_image', image_url: `data:${image.mediaType};base64,${image.dataBase64}` }
}

function toolOutput(block: ResolvedToolResultPart): string | Record<string, unknown>[] {
  const images = block.content.some(part => part.type === 'image')
  if (!images) {
    return block.content.map(part => part.type === 'text' ? part.text : '').join('')
  }
  return block.content.map((part) => {
    if (part.type === 'text') return { type: 'input_text', text: part.text }
    if (part.type === 'image' && 'dataBase64' in part) return imageItem(part)
    throw fixedError('native Codex tool output contains an unsupported content block', 'UNSUPPORTED')
  })
}

export function toResponsesTools(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  return tools.map(tool => ({
    type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters,
  }))
}

/** Responses Lite loads ordinary DSH functions through one canonical namespace. */
export function toResponsesLiteTools(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  const functions = toResponsesTools(tools)
  return functions.length === 0 ? [] : [{
    type: 'namespace', name: 'functions', description: '', tools: functions,
  }]
}

/** Convert resolved DSH messages into Responses instructions and ordered input items. */
export function toResponsesInput(
  messages: readonly ResolvedMessage[], system?: string,
): ResponsesRequestInput {
  const input: Record<string, unknown>[] = []
  const systemTexts: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.replaySource !== undefined) {
      input.push(...replayAssistantInput(
        message.content as readonly ContentBlock[], message.replaySource,
      ))
      continue
    }
    let content: Record<string, unknown>[] = []
    const flush = (): void => {
      if (content.length === 0) return
      input.push({ type: 'message', role: message.role, content })
      content = []
    }
    for (const block of message.content) {
      if (message.role === 'system') {
        if (block.type === 'text') systemTexts.push(block.text)
        else if (block.type === 'image') {
          throw fixedError('native Codex does not support images in system messages', 'UNSUPPORTED')
        }
        continue
      }
      switch (block.type) {
        case 'text':
          content.push({
            type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text,
          })
          break
        case 'image':
          if (message.role === 'assistant') {
            throw fixedError('native Codex does not support assistant image history', 'UNSUPPORTED')
          }
          content.push(imageItem(block))
          break
        case 'tool-call':
          flush()
          input.push({
            type: 'function_call', call_id: String(block.id),
            name: block.name, arguments: block.arguments,
          })
          break
        case 'tool-result':
          flush()
          input.push({
            type: 'function_call_output', call_id: String(block.toolCallId), output: toolOutput(block),
          })
          break
        case 'reasoning':
          break // Visible reasoning is never replayed; M4 may add encrypted items.
        default:
          break
      }
    }
    flush()
  }
  const instructions = system ?? (systemTexts.length === 0 ? undefined : systemTexts.join('\n\n'))
  return { ...instructions === undefined ? {} : { instructions }, input }
}

/** Bound call ids while preserving every function call/result correlation. */
export function normalizeCodexCallIds(
  input: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const mapping = new Map<string, string>()
  const used = new Set<string>()
  const callId = (item: Record<string, unknown>): string | undefined =>
    (item.type === 'function_call' || item.type === 'function_call_output')
      && typeof item.call_id === 'string' ? item.call_id : undefined
  for (const item of input) {
    const id = callId(item)
    if (id !== undefined && id.length <= CALL_ID_MAX_LENGTH) { mapping.set(id, id); used.add(id) }
  }
  for (const item of input) {
    const id = callId(item)
    if (id === undefined || mapping.has(id)) continue
    let attempt = 0
    let normalized: string
    do {
      const hash = createHash('sha256')
      if (attempt > 0) hash.update(String(attempt)).update(String.fromCharCode(0))
      normalized = `${CALL_ID_PREFIX}${hash.update(id).digest('hex').slice(0, CALL_ID_MAX_LENGTH - CALL_ID_PREFIX.length)}`
      attempt += 1
    } while (used.has(normalized))
    mapping.set(id, normalized)
    used.add(normalized)
  }
  return input.map((item) => {
    const id = callId(item)
    const normalized = id === undefined ? undefined : mapping.get(id)
    return normalized === undefined || normalized === id ? item : { ...item, call_id: normalized }
  })
}

function assertSupportedOptions(options: GenerateOptions): void {
  if (options.temperature !== undefined) {
    throw fixedError('native Codex does not support temperature', 'UNSUPPORTED')
  }
  // DSH's compaction and title helpers always carry a bounded output budget, but
  // Codex's native Responses wire has no corresponding request field. Accept the
  // hint only for those purpose-tagged auxiliary calls and leave it off the wire.
  if (options.maxTokens !== undefined
    && options.purpose !== 'compaction'
    && options.purpose !== 'session-title') {
    throw fixedError('native Codex does not support maxTokens', 'UNSUPPORTED')
  }
  if (options.stop !== undefined) {
    throw fixedError('native Codex does not support stop sequences', 'UNSUPPORTED')
  }
}

export interface ResponsesRequestMode {
  serviceTier?: 'priority'
  responsesLite?: { defaultVerbosity?: string; instructionsTemplate?: string }
}

/** Build the canonical Standard/Fast or model-specific Responses Lite body. */
export function codexRequestBody(
  options: GenerateOptions,
  messages: readonly ResolvedMessage[],
  mode: ResponsesRequestMode = {},
): Record<string, unknown> {
  assertSupportedOptions(options)
  if (mode.serviceTier !== undefined && mode.serviceTier !== 'priority') {
    throw fixedError('native Codex service tier is invalid', 'INVALID_ARGS')
  }
  const resolved = toResponsesInput(messages, options.system)
  const instructions = resolved.instructions ?? DEFAULT_CODEX_INSTRUCTIONS
  const input = normalizeCodexCallIds(resolved.input)
  const common = {
    model: options.model,
    tool_choice: 'auto',
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    ...mode.serviceTier === undefined ? {} : { service_tier: mode.serviceTier },
    ...options.sessionId === undefined ? {} : { prompt_cache_key: String(options.sessionId) },
  }
  if (mode.responsesLite === undefined) {
    return {
      ...common,
      instructions,
      input,
      ...options.tools !== undefined && options.tools.length > 0
        ? { tools: toResponsesTools(options.tools) } : {},
      parallel_tool_calls: true,
      ...options.reasoningEffort === undefined ? {}
        : { reasoning: { effort: String(options.reasoningEffort), summary: 'auto' } },
    }
  }

  const tools = toResponsesLiteTools(options.tools ?? [])
  const baseInstructions = mode.responsesLite.instructionsTemplate ?? instructions
  const contextualInstructions = mode.responsesLite.instructionsTemplate !== undefined
      && resolved.instructions !== undefined && resolved.instructions !== baseInstructions
    ? [{
        type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: resolved.instructions }],
      }]
    : []
  const prefixNamespace = uuidBytes(uuidV5(
    UUID_NAMESPACE_OID, String(options.sessionId ?? options.model),
  ))
  const prefix = [{
    type: 'additional_tools',
    id: `at_${uuidV5(prefixNamespace, JSON.stringify(tools))}`,
    role: 'developer',
    tools,
  }, {
    type: 'message',
    id: `msg_${uuidV5(prefixNamespace, baseInstructions)}`,
    role: 'developer',
    content: [{ type: 'input_text', text: baseInstructions }],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['model.base_instructions'],
    },
  }]
  return {
    ...common,
    input: [...prefix, ...contextualInstructions, ...input],
    parallel_tool_calls: false,
    reasoning: {
      ...options.reasoningEffort === undefined ? {} : { effort: String(options.reasoningEffort) },
      summary: 'auto',
      context: 'all_turns',
    },
    ...mode.responsesLite.defaultVerbosity === undefined ? {}
      : { text: { verbosity: mode.responsesLite.defaultVerbosity } },
  }
}

export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

function tokenCount(value: number | undefined, field: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw fixedError(`native Codex response contains invalid ${field} usage`, 'MALFORMED_RESPONSE')
  }
  return value
}

/** Map provider totals to DSH's strict disjoint token counts. */
export function mapResponsesUsage(usage: ResponsesUsage): TokenUsage {
  const totalInput = tokenCount(usage.input_tokens, 'input token')
  const output = tokenCount(usage.output_tokens, 'output token')
  const cached = tokenCount(usage.input_tokens_details?.cached_tokens, 'cached token', 0)
  const written = tokenCount(usage.input_tokens_details?.cache_write_tokens, 'cache-write token', 0)
  const reasoning = tokenCount(usage.output_tokens_details?.reasoning_tokens, 'reasoning token', 0)
  const uncached = totalInput - cached - written
  if (uncached < 0) {
    throw fixedError('native Codex response contains inconsistent input usage', 'MALFORMED_RESPONSE')
  }
  return {
    inputTokens: uncached, outputTokens: output,
    ...cached === 0 ? {} : { cacheReadTokens: cached },
    ...written === 0 ? {} : { cacheWriteTokens: written },
    ...reasoning === 0 ? {} : { reasoningTokens: reasoning },
  }
}

function retryDelay(message?: string): number | undefined {
  const match = message?.match(/try again in[ ]*([0-9]+(?:[.][0-9]+)?)[ ]*(ms|s|seconds?)/i)
  if (match === null || match === undefined) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.min(match[2]?.toLowerCase() === 'ms' ? value : value * 1000, 600_000)
}

/** Classify in-band failure data without reflecting provider text. */
export function responsesFailure(code?: string, message?: string): LlmError {
  const detail = `${code ?? ''} ${message ?? ''}`
  if (code === 'context_length_exceeded' || code === 'context_window_exceeded'
    || isContextWindowExceededError(detail)) {
    return fixedError('native Codex request exceeded the model context window', CONTEXT_WINDOW_EXCEEDED_CODE)
  }
  if (code === 'insufficient_quota' || isQuotaExceededError(detail)) {
    return fixedError('native Codex account quota is exhausted', QUOTA_EXCEEDED_CODE)
  }
  if (code === 'rate_limit_exceeded') {
    const delay = retryDelay(message)
    return new LlmError('native Codex request was rate limited', 'RATE_LIMIT', {
      ...delay === undefined ? {} : { providerRetryAfterMs: delay },
    })
  }
  if (code === 'invalid_prompt' || code === 'bio_policy') {
    return fixedError('native Codex rejected the request', 'INVALID_REQUEST')
  }
  return fixedError('native Codex reported a failed response', 'SERVER')
}

interface ResponsesOutputItem {
  type?: string; id?: string; call_id?: string; name?: string; namespace?: string; arguments?: string
  encrypted_content?: string; summary?: unknown[]; status?: string
  content?: Array<{ type?: string; text?: string }>
}
export interface ResponsesStreamEvent {
  type: string
  item_id?: string; output_index?: number; content_index?: number; summary_index?: number
  delta?: string; text?: string; call_id?: string; name?: string
  item?: ResponsesOutputItem
  response?: {
    status?: string; usage?: ResponsesUsage
    error?: { code?: string; message?: string }
    incomplete_details?: { reason?: string }
  }
  code?: string; message?: string
}
function eventItemId(event: ResponsesStreamEvent): string {
  if (typeof event.item_id === 'string' && event.item_id.length > 0) return event.item_id
  throw fixedError('native Codex SSE event has no item identity', 'MALFORMED_RESPONSE')
}
function eventDelta(event: ResponsesStreamEvent): string {
  if (typeof event.delta === 'string') return event.delta
  throw fixedError('native Codex SSE event has invalid delta text', 'MALFORMED_RESPONSE')
}

interface OpenBlock {
  index: number; kind: 'text' | 'reasoning' | 'tool-call'; text: string
  callId: string; name?: string
}
function closeBlock(block: OpenBlock): ContentBlock {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text }
  return { type: 'tool-call', id: CallId(block.callId), name: block.name ?? '', arguments: block.text }
}

export interface ResponsesReplayContext { provider: string; model: string }

/** Stateful, transport-free Responses event to DSH chunk translator. */
export class ResponsesStreamTranslator {
  private readonly blocks = new Map<string, OpenBlock>()
  private readonly order: OpenBlock[] = []
  private readonly replayCapture: NativeCodexReplayCapture | undefined
  private nextIndex = 0
  private retainedBytes = 0
  private sawToolCall = false
  terminated = false

  constructor(private readonly replayContext?: ResponsesReplayContext) {
    this.replayCapture = replayContext === undefined
      ? undefined
      : new NativeCodexReplayCapture(replayContext.provider, replayContext.model)
  }

  private reserve(bytes: number): void {
    const nextBytes = this.retainedBytes + bytes
    if (!Number.isSafeInteger(nextBytes) || nextBytes > MAX_RETAINED_RESPONSE_BYTES) {
      throw fixedError('native Codex response retained content exceeded the size limit', 'RESPONSE_TOO_LARGE')
    }
    this.retainedBytes = nextBytes
  }

  private append(block: OpenBlock, delta: string): void {
    this.reserve(Buffer.byteLength(delta))
    block.text += delta
  }

  private fill(block: OpenBlock, text: string): void {
    if (block.text.length > 0) return
    this.reserve(Buffer.byteLength(text))
    block.text = text
  }

  private open(
    key: string, kind: OpenBlock['kind'], chunks: StreamChunk[], callId = '', name?: string,
  ): OpenBlock {
    this.reserve(128 + Buffer.byteLength(key) + Buffer.byteLength(callId)
      + (name === undefined ? 0 : Buffer.byteLength(name)))
    const block: OpenBlock = {
      index: this.nextIndex++, kind, text: '', callId,
      ...name === undefined ? {} : { name },
    }
    this.blocks.set(key, block)
    this.order.push(block)
    chunks.push({ type: 'block-start', index: block.index, blockType: kind })
    return block
  }
  private close(key: string, chunks: StreamChunk[]): void {
    const block = this.blocks.get(key)
    if (block === undefined) return
    this.blocks.delete(key)
    chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
  }
  private closeItem(id: string, chunks: StreamChunk[]): void {
    for (const key of [...this.blocks.keys()]) if (key.startsWith(`${id}:`)) this.close(key, chunks)
  }
  private closeAll(chunks: StreamChunk[]): void {
    for (const block of this.order) {
      for (const [key, candidate] of this.blocks) {
        if (candidate === block) { this.close(key, chunks); break }
      }
    }
  }
  push(event: ResponsesStreamEvent): StreamChunk[] {
    if (this.terminated) return []
    const chunks: StreamChunk[] = []
    switch (event.type) {
      case 'response.output_item.added': {
        const item = event.item
        if (item?.type !== 'function_call') return chunks
        if (item.id === undefined || item.id.length === 0
          || item.call_id === undefined || item.call_id.length === 0
          || item.name === undefined || item.name.length === 0) {
          throw fixedError('native Codex function call has invalid identity', 'MALFORMED_RESPONSE')
        }
        this.sawToolCall = true
        const block = this.open(`${item.id}:call`, 'tool-call', chunks, item.call_id, item.name)
        chunks.push({
          type: 'tool-call-delta', index: block.index, id: CallId(block.callId),
          name: item.name, argumentsDelta: '',
        })
        return chunks
      }
      case 'response.output_text.delta': {
        const key = `${eventItemId(event)}:text:${String(event.content_index ?? 0)}`
        const block = this.blocks.get(key) ?? this.open(key, 'text', chunks)
        const delta = eventDelta(event)
        this.append(block, delta)
        chunks.push({ type: 'text-delta', index: block.index, text: delta })
        return chunks
      }
      case 'response.reasoning_summary_text.delta': {
        const key = `${eventItemId(event)}:summary:${String(event.summary_index ?? 0)}`
        const block = this.blocks.get(key) ?? this.open(key, 'reasoning', chunks)
        const delta = eventDelta(event)
        this.append(block, delta)
        chunks.push({ type: 'reasoning-delta', index: block.index, text: delta })
        return chunks
      }
      case 'response.reasoning_text.delta':
        return chunks
      case 'response.function_call_arguments.delta': {
        const key = `${eventItemId(event)}:call`
        const block = this.blocks.get(key)
        if (block === undefined || block.kind !== 'tool-call') {
          throw fixedError('native Codex function arguments have no open call', 'MALFORMED_RESPONSE')
        }
        const delta = eventDelta(event)
        this.append(block, delta)
        chunks.push({
          type: 'tool-call-delta', index: block.index, id: CallId(block.callId),
          ...block.name === undefined ? {} : { name: block.name }, argumentsDelta: delta,
        })
        return chunks
      }
      case 'response.output_item.done': {
        const item = event.item
        if (item?.id === undefined || item.id.length === 0) {
          throw fixedError('native Codex completed item has no identity', 'MALFORMED_RESPONSE')
        }
        const replayId = this.replayContext === undefined ? undefined : replayableItemId(item.id)
        if (item.type === 'function_call') {
          if (item.call_id === undefined || item.call_id.length === 0
            || item.name === undefined || item.name.length === 0
            || (item.namespace !== undefined && (typeof item.namespace !== 'string'
              || item.namespace.length === 0 || Buffer.byteLength(item.namespace) > 256))
            || typeof item.arguments !== 'string') {
            throw fixedError('native Codex function call has invalid content', 'MALFORMED_RESPONSE')
          }
          const key = `${item.id}:call`
          let block = this.blocks.get(key)
          if (block === undefined) {
            this.sawToolCall = true
            block = this.open(key, 'tool-call', chunks, item.call_id, item.name)
          } else if (block.callId !== item.call_id || block.name !== item.name
            || (block.text.length > 0 && block.text !== item.arguments)) {
            throw fixedError('native Codex function call changed during streaming', 'MALFORMED_RESPONSE')
          }
          block.callId = item.call_id
          block.name = item.name
          this.fill(block, item.arguments)
          this.close(key, chunks)
          if (this.replayContext !== undefined) this.replayCapture?.add({
            type: 'function_call', ...(replayId === undefined ? {} : { id: replayId }),
            ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
            block: block.index,
          })
        } else if (item.type === 'message') {
          if (!Array.isArray(item.content)) {
            throw fixedError('native Codex message item has invalid content', 'MALFORMED_RESPONSE')
          }
          const refs: number[] = []
          const expected = new Set<string>()
          for (const [index, part] of item.content.entries()) {
            if (part.type !== 'output_text' || typeof part.text !== 'string' || part.text.length === 0) {
              throw fixedError('native Codex message item has unsupported content', 'MALFORMED_RESPONSE')
            }
            const key = `${item.id}:text:${String(index)}`
            expected.add(key)
            const block = this.blocks.get(key) ?? this.open(key, 'text', chunks)
            if (block.text.length > 0 && block.text !== part.text) {
              throw fixedError('native Codex text changed during streaming', 'MALFORMED_RESPONSE')
            }
            this.fill(block, part.text)
            refs.push(block.index)
            this.close(key, chunks)
          }
          if ([...this.blocks.keys()].some(
            key => key.startsWith(`${item.id}:text:`) && !expected.has(key),
          )) throw fixedError('native Codex message item has unmatched text', 'MALFORMED_RESPONSE')
          if (this.replayContext !== undefined) this.replayCapture?.add({
            type: 'message', ...(replayId === undefined ? {} : { id: replayId }), blocks: refs,
          })
        } else if (item.type === 'reasoning') {
          if (!Array.isArray(item.summary)) {
            throw fixedError('native Codex reasoning summary is invalid', 'MALFORMED_RESPONSE')
          }
          const refs: number[] = []
          const expected = new Set<string>()
          for (const [index, part] of item.summary.entries()) {
            if (typeof part !== 'object' || part === null
              || (part as { type?: unknown }).type !== 'summary_text'
              || typeof (part as { text?: unknown }).text !== 'string'
              || (part as { text: string }).text.length === 0) {
              throw fixedError('native Codex reasoning summary is invalid', 'MALFORMED_RESPONSE')
            }
            const text = (part as { text: string }).text
            const key = `${item.id}:summary:${String(index)}`
            expected.add(key)
            const block = this.blocks.get(key) ?? this.open(key, 'reasoning', chunks)
            if (block.text.length > 0 && block.text !== text) {
              throw fixedError('native Codex reasoning summary changed during streaming', 'MALFORMED_RESPONSE')
            }
            this.fill(block, text)
            refs.push(block.index)
            this.close(key, chunks)
          }
          if ([...this.blocks.keys()].some(
            key => key.startsWith(`${item.id}:summary:`) && !expected.has(key),
          )) throw fixedError('native Codex reasoning item has unmatched summary', 'MALFORMED_RESPONSE')
          const encryptedContent: unknown = item.encrypted_content
          if (encryptedContent !== undefined && encryptedContent !== null
            && (typeof encryptedContent !== 'string' || encryptedContent.length === 0)) {
            throw fixedError('native Codex encrypted reasoning is invalid', 'MALFORMED_RESPONSE')
          }
          if (this.replayContext !== undefined) this.replayCapture?.add({
            type: 'reasoning', ...(replayId === undefined ? {} : { id: replayId }), blocks: refs,
            ...typeof encryptedContent === 'string'
              ? { encryptedContent } : {},
          })
        } else {
          throw fixedError('native Codex completed item type is unsupported', 'UNSUPPORTED')
        }
        return chunks
      }
      case 'response.completed': {
        this.terminated = true
        this.closeAll(chunks)
        if (event.response?.usage !== undefined) {
          chunks.push({ type: 'usage', usage: mapResponsesUsage(event.response.usage) })
        }
        const replayState = this.order.length === 0
          ? undefined
          : this.replayCapture?.finish()
        if (this.order.length > 0 && this.replayContext !== undefined) {
          if (replayState === undefined) {
            throw fixedError('native Codex completed response has no replay descriptors', 'MALFORMED_RESPONSE')
          }
          replayAssistantInput(this.order.map(closeBlock), {
            ...this.replayContext,
            replayState,
          })
        }
        chunks.push(this.order.length === 0
          ? { type: 'finish', reason: { kind: 'error', failure: {
              message: 'native Codex returned a completed response with no content',
              code: EMPTY_RESPONSE_CODE,
            } } }
          : {
              type: 'finish', reason: { kind: this.sawToolCall ? 'tool-calls' : 'stop' },
              ...(replayState === undefined ? {} : { replayState: { response: replayState } }),
            })
        return chunks
      }
      case 'response.incomplete': {
        const reason = event.response?.incomplete_details?.reason
        if (reason !== 'max_output_tokens') {
          throw responsesFailure(reason, event.response?.error?.message)
        }
        this.terminated = true
        this.closeAll(chunks)
        if (event.response?.usage !== undefined) {
          chunks.push({ type: 'usage', usage: mapResponsesUsage(event.response.usage) })
        }
        chunks.push({ type: 'finish', reason: { kind: 'max-tokens' } })
        return chunks
      }
      case 'response.failed':
        throw responsesFailure(event.response?.error?.code, event.response?.error?.message)
      case 'error':
        throw responsesFailure(event.code, event.message)
      default:
        return chunks
    }
  }

  endOfStream(): never {
    throw fixedError('native Codex SSE stream ended before response.completed', 'STREAM_CLOSED')
  }
}

export interface StreamResponsesOptions extends ParseSseOptions {
  onMalformedEvent?: () => void
  onEvent?: (event: ResponsesStreamEvent) => void
  replayContext?: ResponsesReplayContext
}

/** Validate one opaque sticky turn token before retaining or forwarding it. */
export function boundedCodexTurnState(value: unknown): string | undefined {
  let candidate = value
  for (let depth = 0; depth < 8 && Array.isArray(candidate); depth++) candidate = candidate[0]
  return typeof candidate === 'string' && candidate.length > 0
    && Buffer.byteLength(candidate) <= 4096 && !/[\r\n\0]/u.test(candidate)
    ? candidate : undefined
}

/** Extract the bounded sticky turn token from provider metadata/event shapes. */
export function codexResponseTurnState(event: ResponsesStreamEvent): string | undefined {
  const row = event as unknown as Record<string, unknown>
  const response = typeof row.response === 'object' && row.response !== null
    ? row.response as Record<string, unknown> : undefined
  const direct = row.turn_state ?? response?.turn_state
  const boundedDirect = boundedCodexTurnState(direct)
  if (boundedDirect !== undefined) return boundedDirect
  const headers = typeof row.headers === 'object' && row.headers !== null
    ? row.headers as Record<string, unknown> : undefined
  if (headers === undefined) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'x-codex-turn-state') {
      const bounded = boundedCodexTurnState(value)
      if (bounded !== undefined) return bounded
    }
  }
  return undefined
}

/** Consume framed SSE JSON into DSH chunks. */
export async function* streamResponses(
  stream: ReadableStream<Uint8Array>, options: StreamResponsesOptions = {},
): AsyncGenerator<StreamChunk> {
  const translator = new ResponsesStreamTranslator(options.replayContext)
  for await (const frame of parseSse(stream, options)) {
    let event: ResponsesStreamEvent
    try { event = JSON.parse(frame.data) as ResponsesStreamEvent } catch {
      options.onMalformedEvent?.()
      continue
    }
    if (typeof event !== 'object' || event === null || typeof event.type !== 'string') {
      options.onMalformedEvent?.()
      continue
    }
    options.onEvent?.(event)
    yield* translator.push(event)
    if (translator.terminated) return
  }
  translator.endOfStream()
}
