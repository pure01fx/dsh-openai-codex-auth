import { readFile } from 'node:fs/promises'
import {
  CallId, ReasoningEffortId, type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CODEX_INSTRUCTIONS,
  ResponsesStreamTranslator,
  codexRequestBody,
  mapResponsesUsage,
  responsesFailure,
  streamResponses,
  toResponsesInput,
  type ResolvedMessage,
} from '../src/responses.ts'
import { DEFAULT_MAX_SSE_EVENT_BYTES, parseSse } from '../src/sse.ts'

const LF = String.fromCharCode(10)
const CRLF = String.fromCharCode(13, 10)

function bytes(parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function fixture(name: string): Promise<ReadableStream<Uint8Array>> {
  return bytes([await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')])
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'openai-codex-native', model: 'gpt-fixed', messages: [], ...overrides,
  }
}

function errorOf(run: () => unknown): { code?: string; message?: string; failure?: unknown } {
  try { run() } catch (error) { return error as { code?: string; message?: string; failure?: unknown } }
  throw new Error('expected operation to throw')
}

describe('Responses request translation', () => {
  it('maps system, text, tools, images, reasoning, cache identity, and correlated call ids', () => {
    const longId = 'x'.repeat(80)
    const normalized = 'call_d929cdeea7e6a0f46b59448d36a6fd491df8647cf292040508162ee5f64'
    const messages: ResolvedMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'history system' }] },
      { role: 'user', content: [
        { type: 'text', text: 'inspect' },
        { type: 'image', mediaType: 'image/png', dataBase64: 'cG5n' },
      ] },
      { role: 'assistant', content: [
        { type: 'text', text: 'calling' },
        { type: 'reasoning', text: 'must not replay' },
        { type: 'tool-call', id: CallId(longId), name: 'lookup', arguments: '{"key":"safe"}' },
      ] },
      { role: 'user', content: [{
        type: 'tool-result', toolCallId: CallId(longId), isError: false,
        content: [
          { type: 'text', text: 'found' },
          { type: 'image', mediaType: 'image/jpeg', dataBase64: 'anBn' },
        ],
      }] },
    ]
    const body = codexRequestBody(options({
      system: 'explicit system',
      reasoningEffort: ReasoningEffortId('high'),
      sessionId: 'session-fixed' as GenerateOptions['sessionId'],
      tools: [{ name: 'lookup', description: 'safe lookup', parameters: {
        type: 'object', properties: { key: { type: 'string' } }, required: ['key'],
      } }],
    }), messages)

    expect(body).toEqual({
      model: 'gpt-fixed',
      instructions: 'explicit system',
      input: [
        { type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'inspect' },
          { type: 'input_image', image_url: 'data:image/png;base64,cG5n' },
        ] },
        { type: 'message', role: 'assistant', content: [
          { type: 'output_text', text: 'calling' },
        ] },
        { type: 'function_call', call_id: normalized, name: 'lookup', arguments: '{"key":"safe"}' },
        { type: 'function_call_output', call_id: normalized, output: [
          { type: 'input_text', text: 'found' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,anBn' },
        ] },
      ],
      tools: [{
        type: 'function', name: 'lookup', description: 'safe lookup', parameters: {
          type: 'object', properties: { key: { type: 'string' } }, required: ['key'],
        },
      }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { effort: 'high', summary: 'auto' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'session-fixed',
    })
  })

  it('uses message systems only as fallback and otherwise supplies Codex defaults', () => {
    expect(toResponsesInput([
      { role: 'system', content: [{ type: 'text', text: 'one' }] },
      { role: 'system', content: [{ type: 'text', text: 'two' }] },
    ])).toEqual({ instructions: `one${LF}${LF}two`, input: [] })
    expect(codexRequestBody(options(), [])).toEqual({
      model: 'gpt-fixed', instructions: DEFAULT_CODEX_INSTRUCTIONS, input: [],
      tool_choice: 'auto', parallel_tool_calls: true, store: false, stream: true,
      include: ['reasoning.encrypted_content'],
    })
  })

  it('adds only the priority tier for a Fast wire request', () => {
    const standard = codexRequestBody(options({ model: 'gpt-base' }), [])
    const fast = codexRequestBody(options({ model: 'gpt-base' }), [], {
      serviceTier: 'priority',
    })
    expect(standard).not.toHaveProperty('service_tier')
    expect(fast).toEqual({ ...standard, service_tier: 'priority' })
    expect(fast.model).toBe('gpt-base')
    expect(errorOf(() => codexRequestBody(
      options({ model: 'gpt-base' }), [], { serviceTier: 'invalid' } as never,
    ))).toMatchObject({ code: 'INVALID_ARGS' })
  })

  it.each([
    ['temperature', { temperature: 0 }],
    ['maxTokens', { maxTokens: 10 }],
    ['stop sequences', { stop: ['halt'] }],
  ])('rejects unsupported %s without provider I/O', (_label, controls) => {
    expect(errorOf(() => codexRequestBody(options(controls), []))).toMatchObject({ code: 'UNSUPPORTED' })
  })

  it.each(['compaction', 'session-title'] as const)(
    'accepts the required %s output budget without adding a native wire control',
    (purpose) => {
      expect(codexRequestBody(options({ purpose, maxTokens: 8_192 }), []))
        .toEqual(codexRequestBody(options({ purpose }), []))
    },
  )

  it('rejects invalid and assistant-side resolved images with fixed diagnostics', () => {
    expect(errorOf(() => codexRequestBody(options(), [{
      role: 'user', content: [{ type: 'image', mediaType: 'text/plain', dataBase64: 'x' }],
    }]))).toMatchObject({ code: 'MALFORMED_REQUEST' })
    expect(errorOf(() => codexRequestBody(options(), [{
      role: 'assistant', content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'eA==' }],
    }]))).toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('Responses usage and failures', () => {
  it('maps strict disjoint cache and reasoning usage', () => {
    expect(mapResponsesUsage({
      input_tokens: 12, output_tokens: 3,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 1 },
    })).toEqual({
      inputTokens: 6, outputTokens: 3, cacheReadTokens: 4,
      cacheWriteTokens: 2, reasoningTokens: 1,
    })
    expect(mapResponsesUsage({ input_tokens: 2, output_tokens: 0 })).toEqual({
      inputTokens: 2, outputTokens: 0,
    })
  })

  it('rejects noninteger, negative, and inconsistent usage', () => {
    for (const usage of [
      { input_tokens: 1.5, output_tokens: 1 },
      { input_tokens: 1, output_tokens: -1 },
      { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } },
    ]) {
      expect(errorOf(() => mapResponsesUsage(usage))).toMatchObject({ code: 'MALFORMED_RESPONSE' })
    }
  })

  it('classifies failures with fixed messages and bounded provider facts', () => {
    expect(responsesFailure('context_length_exceeded', 'redacted')).toMatchObject({
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: 'native Codex request exceeded the model context window',
    })
    expect(responsesFailure('insufficient_quota', 'redacted')).toMatchObject({ code: 'QUOTA' })
    expect(responsesFailure('rate_limit_exceeded', 'try again in 250 ms; redacted')).toMatchObject({
      code: 'RATE_LIMIT', message: 'native Codex request was rate limited',
      failure: { providerRetryAfterMs: 250 },
    })
    expect(responsesFailure('other', 'secret provider payload').message)
      .toBe('native Codex reported a failed response')
  })
})

describe('ResponsesStreamTranslator', () => {
  it('never exposes hidden reasoning text and exposes summary reasoning only', () => {
    const translator = new ResponsesStreamTranslator()
    expect(translator.push({
      type: 'response.reasoning_text.delta', item_id: 'reason', content_index: 0, delta: 'hidden',
    })).toEqual([])
    expect(translator.push({
      type: 'response.reasoning_summary_text.delta', item_id: 'reason', summary_index: 0, delta: 'Safe.',
    })).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Safe.' },
    ])
    expect(translator.push({
      type: 'response.output_item.done', item: {
        type: 'reasoning', id: 'reason', encrypted_content: 'never-visible',
        summary: [{ type: 'summary_text', text: 'Safe.' }],
      },
    })).toEqual([{ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Safe.' } }])
  })

  it('synthesizes done-only summary and text blocks', () => {
    const translator = new ResponsesStreamTranslator()
    expect(translator.push({ type: 'response.output_item.done', item: {
      type: 'reasoning', id: 'reason', encrypted_content: 'redacted',
      summary: [{ type: 'summary_text', text: 'Summary only.' }],
    } })).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Summary only.' } },
    ])
    expect(translator.push({ type: 'response.output_item.done', item: {
      type: 'message', id: 'message', content: [{ type: 'output_text', text: 'Text only.' }],
    } })).toEqual([
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Text only.' } },
    ])
  })

  it('emits usage before max-token finish and an error finish for empty completion', () => {
    const partial = new ResponsesStreamTranslator()
    partial.push({ type: 'response.output_text.delta', item_id: 'msg', delta: 'partial' })
    expect(partial.push({ type: 'response.incomplete', response: {
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 2, output_tokens: 1 },
    } })).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    expect(new ResponsesStreamTranslator().push({
      type: 'response.completed', response: { usage: { input_tokens: 0, output_tokens: 0 } },
    })).toEqual([
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error', failure: {
        code: 'EMPTY_RESPONSE', message: 'native Codex returned a completed response with no content',
      } } },
    ])
  })
})

describe('SSE framing and stream translation', () => {
  it('maps text, strict usage, and finish from a fixture', async () => {
    expect(await collect(streamResponses(await fixture('responses-text-usage.sse')))).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: {
        inputTokens: 6, outputTokens: 3, cacheReadTokens: 4,
        cacheWriteTokens: 2, reasoningTokens: 1,
      } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('maps visible summary and tool deltas without replay state', async () => {
    expect(await collect(streamResponses(await fixture('responses-tool-reasoning.sse')))).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Checked safely.' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Checked safely.' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'call_redacted', name: 'lookup', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 1, id: 'call_redacted', name: 'lookup', argumentsDelta: '{"key":"safe"}' },
      { type: 'block-end', index: 1, block: {
        type: 'tool-call', id: 'call_redacted', name: 'lookup', arguments: '{"key":"safe"}',
      } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('synthesizes a done-only output item before completion', async () => {
    expect(await collect(streamResponses(await fixture('responses-done-only.sse')))).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Done only.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('treats response.failed as terminal and classifies truncated/empty streams', async () => {
    const failed = `data: ${JSON.stringify({
      type: 'response.failed', response: {
        error: { code: 'rate_limit_exceeded', message: 'try again in 2 seconds' },
      },
    })}${LF}${LF}`
    const laterCompletion = `data: ${JSON.stringify({
      type: 'response.completed', response: {},
    })}${LF}${LF}`
    await expect(collect(streamResponses(bytes([failed, laterCompletion])))).rejects.toMatchObject({
      code: 'RATE_LIMIT', failure: { providerRetryAfterMs: 2000 },
    })
    await expect(collect(streamResponses(await fixture('responses-truncated.sse'))))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    await expect(collect(streamResponses(bytes([])))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('rejects missing item identities and orphaned tool argument deltas', async () => {
    const missingItem = `data: ${JSON.stringify({
      type: 'response.output_text.delta', output_index: 0, delta: 'unsafe',
    })}${LF}${LF}`
    await expect(collect(streamResponses(bytes([missingItem]))))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })

    const orphanedCall = `data: ${JSON.stringify({
      type: 'response.function_call_arguments.delta', item_id: 'call-orphan', delta: '{}',
    })}${LF}${LF}`
    await expect(collect(streamResponses(bytes([orphanedCall]))))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('skips malformed JSON, then accepts a valid terminal response', async () => {
    const malformed = `data: not-json${LF}${LF}`
    const valid = await readFile(new URL('./fixtures/responses-done-only.sse', import.meta.url), 'utf8')
    const onMalformedEvent = vi.fn()
    expect(await collect(streamResponses(bytes([malformed, valid]), { onMalformedEvent }))).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Done only.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(onMalformedEvent).toHaveBeenCalledTimes(1)
  })

  it('frames CRLF, multiline data, comments, and split UTF-8 deterministically', async () => {
    const activity = vi.fn()
    const encoded = new TextEncoder().encode('data: {"v":"✓"}')
    const marker = encoded.indexOf(0xe2)
    const first = new TextDecoder().decode(encoded.slice(0, marker))
    const tail = encoded.slice(marker)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`: ping${CRLF}event: named${CRLF}${first}`))
        controller.enqueue(tail)
        controller.enqueue(new TextEncoder().encode(`${CRLF}data: second${CRLF}${CRLF}`))
        controller.close()
      },
    })
    const frames = []
    for await (const frame of parseSse(stream, { onActivity: activity })) frames.push(frame)
    expect(frames).toEqual([{ event: 'named', data: '{"v":"✓"}' + LF + 'second' }])
    expect(activity.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('does not limit aggregate SSE bytes or event count', async () => {
    const valid = await readFile(new URL('./fixtures/responses-done-only.sse', import.meta.url), 'utf8')
    let responseBytes = 0
    const oneMiBComment = `: ${'a'.repeat(1024 * 1024 - 4)}${LF}${LF}`
    expect(await collect(streamResponses(bytes([
      ...Array.from({ length: 25 }, () => oneMiBComment),
      valid,
    ]), { onBytes: bytesRead => { responseBytes += bytesRead } }))).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Done only.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(responseBytes).toBeGreaterThan(24 * 1024 * 1024)

    const malformed = `data: {}${LF}${LF}`
    const onMalformedEvent = vi.fn()
    expect(await collect(streamResponses(bytes([
      ...Array.from({ length: 4_097 }, () => malformed),
      valid,
    ]), { onMalformedEvent }))).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Done only.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(onMalformedEvent).toHaveBeenCalledTimes(4_097)
  })

  it('fails fixedly on oversize events and cancellation', async () => {
    expect(DEFAULT_MAX_SSE_EVENT_BYTES).toBe(64 * 1024 * 1024)
    await expect(collect(streamResponses(bytes([`data: 1234567890${LF}${LF}`]), {
      maxEventBytes: 8,
    }))).rejects.toMatchObject({
      code: 'SSE_EVENT_TOO_LARGE', message: 'native Codex SSE event exceeded the size limit',
    })

    let cancelled = false
    const pending = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const controller = new AbortController()
    const consuming = collect(streamResponses(pending, { signal: controller.signal }))
    controller.abort()
    await expect(consuming).rejects.toMatchObject({
      code: 'ABORTED', message: 'native Codex SSE stream was cancelled',
    })
    expect(cancelled).toBe(true)
  })
})
