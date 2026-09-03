import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  LlmError,
  createAssistantMessage,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  NATIVE_CODEX_CONNECTION_FAILED_CODE,
  NATIVE_CODEX_PROVIDER,
  NATIVE_CODEX_STREAM_INTERRUPTED_CODE,
} from '../src/native-adapter.ts'
import { NativeCodexWebSocketTransport } from '../src/native-websocket.ts'
import {
  NodeNativeCodexWebSocketFactory,
  nativeCodexWebSocketProxy,
  nativeCodexWebSocketUrl,
  type NativeCodexWebSocket,
  type NativeCodexWebSocketConnectOptions,
  type NativeCodexWebSocketFactory,
  type NativeCodexWebSocketFrame,
} from '../src/native-websocket-socket.ts'

const HTTP_SUCCESS = await readFile(
  new URL('./fixtures/responses-text-usage.sse', import.meta.url), 'utf8',
)
const CREDENTIAL = { accessToken: 'synthetic-token', accountId: 'synthetic-account' }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function completed(id: string, usage = { input_tokens: 1, output_tokens: 1 }): string {
  return JSON.stringify({ type: 'response.completed', response: { id, usage } })
}
function textResponse(id: string, itemId: string, text: string): string[] {
  return [
    JSON.stringify({ type: 'response.output_text.delta', item_id: itemId, delta: text }),
    JSON.stringify({
      type: 'response.output_item.done',
      item: { type: 'message', id: itemId, content: [{ type: 'output_text', text }] },
    }),
    completed(id),
  ]
}
class ScriptedSocket implements NativeCodexWebSocket {
  readonly sent: string[] = []
  closed = false
  constructor(
    private readonly frames: Array<NativeCodexWebSocketFrame | LlmError>,
    readonly responseHeaders: Readonly<Record<string, string>> = {},
  ) {}
  async send(text: string): Promise<void> { this.sent.push(text) }
  async receive(): Promise<NativeCodexWebSocketFrame> {
    const next = this.frames.shift()
    if (next === undefined) throw new LlmError('fixture exhausted', 'WS_RETRYABLE')
    if (next instanceof LlmError) throw next
    return next
  }
  close(): void { this.closed = true }
}
function socket(events: string[], headers: Record<string, string> = {}): ScriptedSocket {
  return new ScriptedSocket(events.map(text => ({ type: 'text', text })), headers)
}
class ScriptedFactory implements NativeCodexWebSocketFactory {
  readonly options: NativeCodexWebSocketConnectOptions[] = []
  constructor(private readonly outcomes: Array<NativeCodexWebSocket | LlmError>) {}
  async connect(options: NativeCodexWebSocketConnectOptions): Promise<NativeCodexWebSocket> {
    this.options.push(options)
    const next = this.outcomes.shift()
    if (next === undefined) throw new LlmError('fixture exhausted', 'WS_RETRYABLE')
    if (next instanceof LlmError) throw next
    return next
  }
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
function firstRequest(message = createUserMessage({
  content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
})): GenerateOptions {
  return {
    provider: NATIVE_CODEX_PROVIDER,
    model: 'gpt-base',
    sessionId: 'session-fixed' as GenerateOptions['sessionId'],
    messages: [message],
  }
}
function response(body = HTTP_SUCCESS): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
function wrappedNetworkFailure(code: string): LlmError {
  return new LlmError('managed credential request failed', code, {
    cause: new TypeError('fetch failed', {
      cause: Object.assign(new Error('network unavailable'), { code: 'ENETUNREACH' }),
    }),
  })
}
function finishState(chunks: StreamChunk[]): unknown {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  if (finish?.type !== 'finish') throw new Error('missing finish')
  return finish.replayState
}

describe('NativeCodexWebSocketTransport', () => {
  it('sends exact v2 handshake, prewarm, and cross-turn incremental suffix', async () => {
    const scripted = socket([
      JSON.stringify({ type: 'response.created', response: { turn_state: 'turn-one' } }),
      completed('resp_warm'),
      ...textResponse('resp_one', 'msg_one', 'ok'),
      ...textResponse('resp_two', 'msg_two', 'done'),
    ], { 'x-codex-turn-state': 'turn-one' })
    const factory = new ScriptedFactory([scripted])
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      fetch: fetchMock as typeof fetch,
    })
    expect((transport as unknown as { idleTimeoutMs: number }).idleTimeoutMs).toBe(300_000)

    const first = await collect(transport.stream(firstRequest()))
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'ok' }],
      source: {
        provider: NATIVE_CODEX_PROVIDER,
        model: 'gpt-base',
        replayState: finishState(first),
      },
    })
    const nextUser = createUserMessage({
      content: [{ type: 'text', text: 'next' }], source: { kind: 'user' },
    })
    await collect(transport.stream({
      ...firstRequest(), messages: [firstRequest().messages[0]!, assistant, nextUser],
    }))

    expect(factory.options).toHaveLength(1)
    expect(factory.options[0]).toMatchObject({
      url: 'https://chatgpt.com/backend-api/codex/responses',
      maxFrameBytes: 64 * 1024 * 1024,
      headers: {
        authorization: 'Bearer synthetic-token',
        'chatgpt-account-id': 'synthetic-account',
        originator: 'dsh',
        'session-id': 'session-fixed',
        'thread-id': 'session-fixed',
        'x-client-request-id': 'session-fixed',
        'x-codex-routing-hint': 'model=gpt-base',
        'openai-beta': 'responses_websockets=2026-02-06',
      },
    })
    expect(scripted.sent).toHaveLength(3)
    const [warmup, initial, incremental] = scripted.sent.map(text => JSON.parse(text))
    expect(warmup).toMatchObject({
      type: 'response.create', model: 'gpt-base', generate: false,
    })
    expect(warmup.input).toHaveLength(1)
    expect(initial).toMatchObject({
      type: 'response.create', model: 'gpt-base',
      previous_response_id: 'resp_warm', input: [],
      client_metadata: { 'x-codex-turn-state': 'turn-one' },
    })
    expect(incremental).toMatchObject({
      type: 'response.create', model: 'gpt-base',
      previous_response_id: 'resp_one',
    })
    expect(incremental.input).toHaveLength(1)
    expect(incremental.client_metadata).toBeUndefined()
    expect(JSON.stringify(scripted.sent)).not.toContain('synthetic-token')
    expect(JSON.stringify(scripted.sent)).not.toContain('synthetic-account')
    expect(fetchMock).not.toHaveBeenCalled()
    transport.dispose()
  })

  it('drops settled subagent reasoning and tool calls before WebSocket prewarm', async () => {
    const scripted = socket([
      completed('resp_warm_settlement'),
      ...textResponse('resp_settlement', 'msg_settlement', 'ok'),
    ])
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([scripted]),
      fetch: fetchMock as typeof fetch,
    })
    const messages = [{
      id: 'message-subagent-settled',
      role: 'user',
      content: [
        { type: 'text', text: 'Background subagent child-session finished.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'reasoning', text: 'private WebSocket relayed reasoning' },
        {
          type: 'tool-call', id: 'call_child_websocket_settlement',
          name: 'child_tool', arguments: '{"scope":"child"}',
        },
        { type: 'text', text: 'The focused review is complete.' },
      ],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: 'Background subagent child-session finished.',
        senderSessionId: 'child-session',
      },
    }, {
      id: 'message-human-retry',
      role: 'user',
      content: [{ type: 'text', text: 'Please continue after the settlement.' }],
      source: { kind: 'user' },
    }] as unknown as GenerateOptions['messages']

    await collect(transport.stream({ ...firstRequest(), messages }))

    const [warmup, initial] = scripted.sent.map(text => JSON.parse(text))
    expect(warmup.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Background subagent child-session finished.' },
        { type: 'input_text', text: 'Its closing message:' },
        { type: 'input_text', text: 'The focused review is complete.' },
      ],
    }, {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Please continue after the settlement.' }],
    }])
    expect(JSON.stringify(scripted.sent)).not.toContain('private WebSocket relayed reasoning')
    expect(JSON.stringify(scripted.sent)).not.toContain('call_child_websocket_settlement')
    expect(initial).toMatchObject({ previous_response_id: 'resp_warm_settlement', input: [] })
    expect(fetchMock).not.toHaveBeenCalled()
    transport.dispose()
  })

  it('prewarms histories with more than 2048 input items', async () => {
    const scripted = socket([
      completed('resp_warm_large'),
      ...textResponse('resp_large', 'msg_large', 'ok'),
    ])
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([scripted]),
    })
    const messages = Array.from({ length: 2049 }, (_, index) => createUserMessage({
      content: [{ type: 'text', text: String(index) }], source: { kind: 'user' },
    }))

    await collect(transport.stream({ ...firstRequest(), messages }))

    const [warmup, initial] = scripted.sent.map(text => JSON.parse(text))
    expect(warmup.input).toHaveLength(2049)
    expect(initial).toMatchObject({
      previous_response_id: 'resp_warm_large', input: [],
    })
  })

  it('publishes subscription quota from codex.rate_limits events', async () => {
    const quota = vi.fn()
    const scripted = socket([
      completed('resp_warm'),
      JSON.stringify({
        type: 'codex.rate_limits',
        plan_type: 'plus',
        rate_limits: {
          limit_reached: false,
          primary: { used_percent: 42, window_minutes: 300, reset_at: 1_700_000_000 },
          secondary: null,
        },
        credits: { has_credits: true, unlimited: false, balance: '123' },
      }),
      ...textResponse('resp_one', 'msg_one', 'ok'),
    ])
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([scripted]),
      fetch: vi.fn(async () => response()) as typeof fetch,
      onRateLimits: quota,
    })

    await collect(transport.stream(firstRequest()))
    expect(quota).toHaveBeenCalledWith({
      accountId: 'synthetic-account',
      updates: [{
        limitId: 'codex',
        planType: 'plus',
        primary: { usedPercent: 42, windowSeconds: 18_000, resetAt: 1_700_000_000 },
        secondary: null,
        limitReached: false,
        credits: { hasCredits: true, unlimited: false, balance: '123' },
      }],
    })
  })

  it('publishes exact response usage metadata over WebSocket', async () => {
    const usage = vi.fn()
    const responseEvents = textResponse('resp_one', 'msg_one', 'ok')
    responseEvents[responseEvents.length - 1] = JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_one',
        usage_metadata: { amount: '0.12345678901234567890' },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([socket([
        completed('resp_warm'),
        ...responseEvents,
      ])]),
      fetch: vi.fn(async () => response()) as typeof fetch,
      onResponseUsage: usage,
    })

    await collect(transport.stream(firstRequest()))

    expect(usage).toHaveBeenCalledWith({
      accountId: CREDENTIAL.accountId,
      metadata: { amount: '0.12345678901234567890' },
    })
  })

  it('does not limit aggregate WebSocket event count', async () => {
    const ignored = Array.from({ length: 4_097 }, (_, sequenceNumber) => JSON.stringify({
      type: 'response.unknown', sequence_number: sequenceNumber,
    }))
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([socket([
        completed('resp_warm'),
        ...ignored,
        ...textResponse('resp_many', 'msg_many', 'done'),
      ])]),
      fetch: vi.fn(async () => response()) as typeof fetch,
    })

    await expect(collect(transport.stream(firstRequest()))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'finish' })]),
    )
  })

  it('does not limit WebSocket output item count', async () => {
    const outputItems = Array.from({ length: 2_049 }, (_, index) => JSON.stringify({
      type: 'response.output_item.done',
      item: { type: 'message', id: `msg_${String(index)}`, content: [] },
    }))
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([socket([
        completed('resp_warm'),
        ...outputItems,
        completed('resp_many_items'),
      ])]),
      fetch: vi.fn(async () => response()) as typeof fetch,
    })

    await expect(collect(transport.stream(firstRequest()))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'finish' })]),
    )
  })

  it('reconnects with a full create without repeating prewarm', async () => {
    const closed = new ScriptedSocket([{ type: 'close', code: 1011, reason: 'retry' }])
    const recovered = socket(textResponse('resp_success', 'msg_success', 'ok'))
    const factory = new ScriptedFactory([closed, recovered])
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      fetch: fetchMock as typeof fetch,
      maxWebSocketReconnects: 1,
      sleep: async () => {},
    })

    await expect(collect(transport.stream(firstRequest()))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'finish' })]),
    )
    expect(factory.options).toHaveLength(2)
    expect(recovered.sent.map(text => JSON.parse(text))).toEqual([
      expect.objectContaining({ type: 'response.create' }),
    ])
    expect(JSON.parse(recovered.sent[0]!)).not.toHaveProperty('generate')
    expect(JSON.parse(recovered.sent[0]!)).not.toHaveProperty('previous_response_id')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bounds credential-backed WebSocket connection outages before HTTP fallback', async () => {
    const delays: number[] = []
    const factory = new ScriptedFactory([
      new LlmError('offline prewarm', NATIVE_CODEX_CONNECTION_FAILED_CODE),
      new LlmError('still offline', NATIVE_CODEX_CONNECTION_FAILED_CODE),
    ])
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      fetch: fetchMock as typeof fetch,
      maxWebSocketReconnects: 0,
      initialRetryDelayMs: 200,
      random: () => 0.5,
      sleep: async delay => { delays.push(delay) },
    })

    await expect(collect(transport.stream(firstRequest()))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'finish' })]),
    )

    expect(factory.options).toHaveLength(2)
    expect(delays).toEqual([200])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cancels promptly while waiting for WebSocket network recovery', async () => {
    const controller = new AbortController()
    const factory = new ScriptedFactory([
      new LlmError('offline', NATIVE_CODEX_CONNECTION_FAILED_CODE),
    ])
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      maxWebSocketReconnects: 0,
    })
    const pending = collect(transport.stream({
      ...firstRequest(), signal: controller.signal,
    }))
    await vi.waitFor(() => expect(factory.options).toHaveLength(1))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(factory.options).toHaveLength(1)
  })

  it('preserves DISPOSED while stopping a WebSocket network recovery wait', async () => {
    const factory = new ScriptedFactory([
      new LlmError('offline', NATIVE_CODEX_CONNECTION_FAILED_CODE),
    ])
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      maxWebSocketReconnects: 0,
    })
    const pending = collect(transport.stream(firstRequest()))
    await vi.waitFor(() => expect(factory.options).toHaveLength(1))
    transport.dispose()

    await expect(pending).rejects.toMatchObject({ code: 'DISPOSED' })
    expect(factory.options).toHaveLength(1)
  })

  it('waits for wrapped credential resolution outages without using reconnects', async () => {
    let resolutions = 0
    const resolveCredential = vi.fn(async () => {
      if (resolutions++ < 2) throw wrappedNetworkFailure('INVALID_CREDENTIAL')
      return CREDENTIAL
    })
    const recovered = socket([
      completed('resp_warm_resolved'),
      ...textResponse('resp_resolved', 'msg_resolved', 'back'),
    ])
    const factory = new ScriptedFactory([recovered])
    const delays: number[] = []
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential,
      webSocketFactory: factory,
      maxWebSocketReconnects: 0,
      sleep: async delay => { delays.push(delay) },
    })

    await collect(transport.stream(firstRequest()))

    expect(resolveCredential).toHaveBeenCalledTimes(3)
    expect(factory.options).toHaveLength(1)
    expect(delays).toEqual([5_000, 10_000])
  })

  it('retries wrapped credential recovery outages without falling back', async () => {
    const recovered = socket([
      completed('resp_warm_recovered'),
      ...textResponse('resp_recovered', 'msg_recovered', 'back'),
    ])
    const factory = new ScriptedFactory([
      new LlmError('unauthorized one', 'WS_AUTH'),
      new LlmError('unauthorized two', 'WS_AUTH'),
      recovered,
    ])
    let recoveries = 0
    const recoverCredential = vi.fn(async () => {
      if (recoveries++ === 0) throw wrappedNetworkFailure('AUTH')
      return true
    })
    const fetchMock = vi.fn(async () => response())
    const delays: number[] = []
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      recoverCredential,
      webSocketFactory: factory,
      fetch: fetchMock as typeof fetch,
      maxWebSocketReconnects: 0,
      sleep: async delay => { delays.push(delay) },
    })

    await collect(transport.stream(firstRequest()))

    expect(recoverCredential).toHaveBeenCalledTimes(2)
    expect(factory.options).toHaveLength(3)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(delays).toEqual([5_000])
  })

  it('preserves DISPOSED while credential recovery is pending', async () => {
    const recoverCredential = vi.fn((_previous, signal?: AbortSignal) =>
      new Promise<boolean>((_resolve, reject) => {
        const abort = (): void => { reject(signal?.reason ?? new Error('aborted')) }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      }))
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      recoverCredential,
      webSocketFactory: new ScriptedFactory([new LlmError('unauthorized', 'WS_AUTH')]),
    })
    const pending = collect(transport.stream(firstRequest()))
    await vi.waitFor(() => expect(recoverCredential).toHaveBeenCalledTimes(1))

    transport.dispose()

    await expect(pending).rejects.toMatchObject({ code: 'DISPOSED' })
  })

  it('preserves DISPOSED while image request preparation is pending', async () => {
    const readImage = vi.fn((_attachment: unknown, signal?: AbortSignal) =>
      new Promise<{ data: Uint8Array }>((_resolve, reject) => {
        const abort = (): void => { reject(signal?.reason ?? new Error('aborted')) }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      }))
    const factory = new ScriptedFactory([])
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      readImage,
      webSocketFactory: factory,
    })
    const pending = collect(transport.stream({
      ...firstRequest(),
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          attachment: {
            attachmentId: 'attachment-pending', mediaType: 'image/png', bytes: 3,
            width: 1, height: 1,
          },
        }],
      }] as unknown as GenerateOptions['messages'],
    }))
    await vi.waitFor(() => expect(readImage).toHaveBeenCalledTimes(1))

    transport.dispose()

    await expect(pending).rejects.toMatchObject({ code: 'DISPOSED' })
    expect(factory.options).toHaveLength(0)
  })

  it('preserves DISPOSED through a pending HTTP fallback', async () => {
    const fetchMock = vi.fn((_input: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = (): void => { reject(init?.signal?.reason ?? new Error('aborted')) }
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      }))
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([
        new LlmError('upgrade unavailable', 'WS_UPGRADE_REQUIRED'),
      ]),
      fetch: fetchMock as typeof fetch,
      maxWebSocketReconnects: 0,
    })
    const pending = collect(transport.stream(firstRequest()))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    transport.dispose()

    await expect(pending).rejects.toMatchObject({ code: 'DISPOSED' })
  })

  it('backs off reconnects and honors bounded provider retry delays', async () => {
    const delays: number[] = []
    const factory = new ScriptedFactory([
      new LlmError('retry later', 'WS_RETRYABLE', { providerRetryAfterMs: 2_000 }),
      socket(textResponse('resp_success', 'msg_success', 'ok')),
    ])
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      maxWebSocketReconnects: 1,
      initialRetryDelayMs: 200,
      maxRetryDelayMs: 1_000,
      random: () => 0.5,
      sleep: async delay => { delays.push(delay) },
    })

    await collect(transport.stream(firstRequest()))

    expect(factory.options).toHaveLength(2)
    expect(delays).toEqual([1_000])
  })

  it('falls back immediately on 426 and keeps the session on HTTP', async () => {
    const factory = new ScriptedFactory([
      new LlmError('upgrade required', 'WS_UPGRADE_REQUIRED'),
    ])
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      fetch: fetchMock as typeof fetch,
    })

    await collect(transport.stream(firstRequest()))
    await collect(transport.stream(firstRequest(createUserMessage({
      content: [{ type: 'text', text: 'later' }], source: { kind: 'user' },
    }))))
    expect(factory.options).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back only before visible output', async () => {
    const beforeOutput = new ScriptedFactory([
      new LlmError('connect failed', 'WS_RETRYABLE'),
    ])
    const firstFetch = vi.fn(async () => response())
    const safe = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: beforeOutput,
      fetch: firstFetch as typeof fetch,
      maxWebSocketReconnects: 0,
    })
    await collect(safe.stream(firstRequest()))
    expect(firstFetch).toHaveBeenCalledTimes(1)

    const partial = socket([
      completed('resp_warm'),
      JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_partial', delta: 'part' }),
      JSON.stringify({ type: 'response.output_item.done', item: {
        type: 'message', id: 'msg_partial', content: [{ type: 'output_text', text: 'part' }],
      } }),
      JSON.stringify({
        type: 'error',
        headers: { 'Retry-After': '30', 'X-Request-Id': 'req-post-output' },
        error: { code: 'websocket_connection_limit_reached' },
      }),
    ])
    const secondFetch = vi.fn(async () => response())
    const unsafe = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([partial]),
      fetch: secondFetch as typeof fetch,
    })
    const chunks: StreamChunk[] = []
    const error = await (async () => {
      try {
        for await (const chunk of unsafe.stream(firstRequest())) chunks.push(chunk)
      } catch (caught) { return caught }
    })()
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'part' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'part' } },
    ])
    expect(error).toMatchObject({
      code: NATIVE_CODEX_STREAM_INTERRUPTED_CODE,
      failure: {
        providerRetryAfterMs: 10_000,
        requestId: 'req-post-output',
      },
    })
    expect((error as Error & { cause?: unknown }).cause)
      .toMatchObject({ code: 'WS_RETRYABLE_RESET' })
    expect(secondFetch).not.toHaveBeenCalled()
  })

  it('never replays a post-output socket reset inside the same stream', async () => {
    const reset = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
    const partial = new ScriptedSocket([
      { type: 'text', text: completed('resp_warm_reset') },
      { type: 'text', text: JSON.stringify({
        type: 'response.output_text.delta', item_id: 'msg_reset', delta: 'part',
      }) },
      new LlmError('established socket failed', 'WS_RETRYABLE', { cause: reset }),
    ])
    const unused = socket(textResponse('resp_unused', 'msg_unused', 'must-not-run'))
    const factory = new ScriptedFactory([partial, unused])
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      sleep: async () => { throw new Error('must not reconnect in-stream') },
    })
    const chunks: StreamChunk[] = []
    const error = await (async () => {
      try {
        for await (const chunk of transport.stream(firstRequest())) chunks.push(chunk)
      } catch (caught) { return caught }
    })()

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'part' },
    ])
    expect(error).toMatchObject({ code: NATIVE_CODEX_STREAM_INTERRUPTED_CODE })
    expect(factory.options).toHaveLength(1)
    expect(unused.sent).toEqual([])
  })

  it('recovers one handshake credential and enforces Fast account authority', async () => {
    let token = 'old-token'
    const scripted = socket([
      completed('resp_warm'),
      ...textResponse('resp_ok', 'msg_ok', 'ok'),
    ])
    const factory = new ScriptedFactory([
      new LlmError('unauthorized', 'WS_AUTH'), scripted,
    ])
    const recover = vi.fn(async () => { token = 'new-token'; return true })
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => ({ accessToken: token, accountId: 'account-a' }),
      recoverCredential: recover,
      webSocketFactory: factory,
    })
    const authorityHash = (await import('../src/catalog.ts')).nativeCodexAuthorityHash('account-a')
    await collect(transport.stream(firstRequest(), {
      serviceTier: 'priority', publicModel: 'gpt-base-fast', authorityHash,
    }))
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith(
      { accessToken: 'old-token', accountId: 'account-a' },
      expect.any(AbortSignal),
    )
    expect(factory.options).toHaveLength(2)
    expect(factory.options[1]?.headers['x-codex-routing-hint'])
      .toBe('model=gpt-base;tier=priority')
    const fastWarmup = JSON.parse(scripted.sent[0]!)
    expect(fastWarmup).toMatchObject({ model: 'gpt-base', service_tier: 'priority' })
    expect(JSON.stringify(fastWarmup)).not.toContain('gpt-base-fast')

    const rejectedFactory = new ScriptedFactory([scripted])
    const rejected = new NativeCodexWebSocketTransport({
      resolveCredential: async () => ({ accessToken: 'token-b', accountId: 'account-b' }),
      webSocketFactory: rejectedFactory,
    })
    await expect(collect(rejected.stream(firstRequest(), {
      serviceTier: 'priority', publicModel: 'gpt-base-fast', authorityHash,
    }))).rejects.toMatchObject({ code: 'FAST_CAPABILITY_UNAVAILABLE' })
    expect(rejectedFactory.options).toHaveLength(0)
  })

  it('rejects a cross-account credential after WebSocket recovery', async () => {
    let credential = { accessToken: 'token-a', accountId: 'account-a' }
    const factory = new ScriptedFactory([
      new LlmError('unauthorized', 'WS_AUTH'),
      socket(textResponse('resp_unused', 'msg_unused', 'must not run')),
    ])
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => credential,
      recoverCredential: async () => {
        credential = { accessToken: 'token-b', accountId: 'account-b' }
        return true
      },
      webSocketFactory: factory,
    })

    await expect(collect(transport.stream(firstRequest()))).rejects.toMatchObject({
      code: 'AUTH', message: 'native Codex account changed during request',
    })
    expect(factory.options).toHaveLength(1)
  })

  it('carries the account pin into HTTP fallback', async () => {
    let credential = { accessToken: 'token-a', accountId: 'account-a' }
    let connects = 0
    const webSocketFactory: NativeCodexWebSocketFactory = {
      connect: vi.fn(async () => {
        connects += 1
        if (connects === 2) credential = { accessToken: 'token-b', accountId: 'account-b' }
        throw new LlmError('socket unavailable', 'WS_RETRYABLE')
      }),
    }
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => credential,
      webSocketFactory,
      fetch: fetchMock as typeof fetch,
      maxWebSocketReconnects: 0,
      sleep: async () => {},
    })

    await expect(collect(transport.stream(firstRequest()))).rejects.toMatchObject({
      code: 'AUTH', message: 'native Codex account changed during request',
    })
    expect(webSocketFactory.connect).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('closes and resets a pooled socket when the consumer stops early', async () => {
    const abandoned = socket([
      completed('resp_warm_abandoned'),
      ...textResponse('resp_abandoned', 'msg_abandoned', 'partial'),
    ])
    const replacement = socket(textResponse(
      'resp_replacement', 'msg_replacement', 'ok',
    ))
    const factory = new ScriptedFactory([abandoned, replacement])
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
    })
    const iterator = transport.stream(firstRequest())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'block-start', index: 0, blockType: 'text' }, done: false,
    })
    await iterator.return?.()
    expect(abandoned.closed).toBe(true)

    await collect(transport.stream(firstRequest()))
    expect(factory.options).toHaveLength(2)
    expect(replacement.sent.map(text => JSON.parse(text))).toEqual([
      expect.objectContaining({ type: 'response.create' }),
    ])
    expect(JSON.parse(replacement.sent[0]!)).not.toHaveProperty('generate')
    expect(JSON.parse(replacement.sent[0]!)).not.toHaveProperty('previous_response_id')
  })

  it('uses one startup prewarm plus five normal reconnects before sticky fallback', async () => {
    const factory = new ScriptedFactory([
      new LlmError('prewarm', 'WS_RETRYABLE'),
      new LlmError('initial', 'WS_RETRYABLE'),
      new LlmError('retry one', 'WS_RETRYABLE'),
      new LlmError('retry two', 'WS_RETRYABLE'),
      new LlmError('retry three', 'WS_RETRYABLE'),
      new LlmError('retry four', 'WS_RETRYABLE'),
      new LlmError('retry five', 'WS_RETRYABLE'),
    ])
    const fetchMock = vi.fn(async () => response())
    const delays: number[] = []
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      fetch: fetchMock as typeof fetch,
      random: () => 0.5,
      sleep: async delay => { delays.push(delay) },
    })
    await collect(transport.stream(firstRequest()))
    await collect(transport.stream(firstRequest()))
    expect(factory.options).toHaveLength(7)
    expect(delays).toEqual([200, 200, 400, 800, 1_600, 3_200])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes sticky HTTP fallback lifetime on each continued request', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const factory = new ScriptedFactory([
      new LlmError('upgrade required', 'WS_UPGRADE_REQUIRED'),
    ])
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      fetch: fetchMock as typeof fetch,
      webSocketSessionIdleMs: 1_000,
    })
    await collect(transport.stream(firstRequest()))
    now = 500
    await collect(transport.stream(firstRequest()))
    now = 1_200
    await collect(transport.stream(firstRequest()))
    expect(factory.options).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reconnects and resets the chain when previous response is unavailable', async () => {
    const stale = socket([
      JSON.stringify({
        type: 'response.metadata',
        headers: { 'X-Codex-Turn-State': ['same-turn-sticky'] },
      }),
      completed('resp_warm_stale'),
      JSON.stringify({ type: 'error', error: { code: 'previous_response_not_found' } }),
    ])
    const fresh = socket(textResponse('resp_fresh', 'msg_fresh', 'ok'))
    const factory = new ScriptedFactory([stale, fresh])
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      fetch: fetchMock as typeof fetch,
      sleep: async () => {},
    })
    await collect(transport.stream(firstRequest()))
    expect(factory.options).toHaveLength(2)
    expect(fresh.sent.map(text => JSON.parse(text))).toEqual([
      expect.objectContaining({
        type: 'response.create',
        client_metadata: { 'x-codex-turn-state': 'same-turn-sticky' },
      }),
    ])
    expect(JSON.parse(fresh.sent[0]!)).not.toHaveProperty('generate')
    expect(JSON.parse(fresh.sent[0]!)).not.toHaveProperty('previous_response_id')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('carries metadata turn state into HTTP fallback for the same turn', async () => {
    const scripted = socket([
      JSON.stringify({
        type: 'response.metadata',
        headers: { 'x-cOdEx-TuRn-StAtE': 'fallback-sticky' },
      }),
      completed('resp_warm'),
      JSON.stringify({ type: 'error', error: { code: 'websocket_connection_limit_reached' } }),
    ])
    let fallbackHeaders: Headers | undefined
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      fallbackHeaders = new Headers(init?.headers)
      return response()
    })
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([scripted]),
      fetch: fetchMock as typeof fetch,
      maxWebSocketReconnects: 0,
    })
    await collect(transport.stream(firstRequest()))
    expect(fallbackHeaders?.get('x-codex-turn-state')).toBe('fallback-sticky')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('classifies wrapped outer status_code without unsafe fallback', async () => {
    const scripted = socket([
      completed('resp_warm'),
      JSON.stringify({
        type: 'error', status_code: 429,
        headers: {
          'Retry-After': '2',
          'X-Request-Id': ['req-ws-rate'],
          'X-Codex-Primary-Used-Percent': 100,
          'X-Codex-Primary-Window-Minutes': 15,
        },
        error: { message: 'bounded' },
      }),
    ])
    const fetchMock = vi.fn(async () => response())
    const quota = vi.fn()
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([scripted]),
      fetch: fetchMock as typeof fetch,
      onRateLimits: quota,
    })
    await expect(collect(transport.stream(firstRequest()))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      failure: { status: 429, providerRetryAfterMs: 2_000, requestId: 'req-ws-rate' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(quota).toHaveBeenCalledWith({
      accountId: 'synthetic-account',
      updates: [{
        limitId: 'codex',
        primary: { usedPercent: 100, windowSeconds: 900 },
        limitReached: true,
      }],
    })
  })

  it('aborts active work and fences all requests after disposal', async () => {
    class PendingSocket implements NativeCodexWebSocket {
      readonly responseHeaders = {}
      readonly sent: string[] = []
      closed = false
      async send(text: string): Promise<void> { this.sent.push(text) }
      async receive(signal?: AbortSignal): Promise<NativeCodexWebSocketFrame> {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new LlmError('aborted', 'ABORTED'))
          }, { once: true })
        })
      }
      close(): void { this.closed = true }
    }
    const pendingSocket = new PendingSocket()
    const factory = new ScriptedFactory([pendingSocket])
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      fetch: fetchMock as typeof fetch,
      maxWebSocketSessions: 1,
    })
    const iterator = transport.stream(firstRequest())[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(pendingSocket.sent).toHaveLength(1) })
    await expect(collect(transport.stream({
      ...firstRequest(),
      sessionId: 'session-second' as GenerateOptions['sessionId'],
    }))).rejects.toMatchObject({ code: 'WS_SESSION_LIMIT' })
    transport.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'DISPOSED' })
    expect(pendingSocket.closed).toBe(true)
    await expect(collect(transport.stream(firstRequest())))
      .rejects.toMatchObject({ code: 'DISPOSED' })
    expect(factory.options).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never switches transport for non-retryable rate and request failures', async () => {
    for (const code of ['RATE_LIMITED', 'INVALID_REQUEST']) {
      const factory = new ScriptedFactory([new LlmError('rejected', code)])
      const fetchMock = vi.fn(async () => response())
      const transport = new NativeCodexWebSocketTransport({
        resolveCredential: async () => CREDENTIAL,
        webSocketFactory: factory,
        fetch: fetchMock as typeof fetch,
      })
      await expect(collect(transport.stream(firstRequest())))
        .rejects.toMatchObject({ code })
      expect(factory.options).toHaveLength(1)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('preserves a structured reason for a pre-aborted socket connection', async () => {
    const controller = new AbortController()
    controller.abort(new LlmError('disposed', 'DISPOSED'))
    const factory = new NodeNativeCodexWebSocketFactory()

    await expect(factory.connect({
      url: 'https://chatgpt.com/backend-api/codex/responses',
      headers: {},
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'DISPOSED' })
  })



  it('uses opt-in HTTP proxy environment variables and respects NO_PROXY', () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '')
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890')
    vi.stubEnv('https_proxy', '')
    vi.stubEnv('NO_PROXY', '')
    vi.stubEnv('no_proxy', '')
    expect(nativeCodexWebSocketProxy('https://chatgpt.com/backend-api/codex/responses'))
      .toBeUndefined()

    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    expect(nativeCodexWebSocketProxy('https://chatgpt.com/backend-api/codex/responses'))
      .toBe('http://127.0.0.1:7890')

    vi.stubEnv('NO_PROXY', 'chatgpt.com')
    expect(nativeCodexWebSocketProxy('https://chatgpt.com/backend-api/codex/responses'))
      .toBeUndefined()

    vi.stubEnv('NO_PROXY', '')
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:7891')
    vi.stubEnv('http_proxy', '')
    expect(nativeCodexWebSocketProxy('http://127.0.0.2:8080/responses'))
      .toBe('http://127.0.0.1:7891')
  })

  it('tunnels the WebSocket handshake through the selected HTTP proxy', async () => {
    const destinations: string[] = []
    const proxy = createServer()
    proxy.on('connect', (request, socket) => {
      destinations.push(request.url ?? '')
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = proxy.address() as AddressInfo
      vi.stubEnv('NODE_USE_ENV_PROXY', '1')
      vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${String(address.port)}`)
      vi.stubEnv('https_proxy', '')
      vi.stubEnv('NO_PROXY', '')
      vi.stubEnv('no_proxy', '')

      await expect(new NodeNativeCodexWebSocketFactory().connect({
        url: 'https://chatgpt.com/backend-api/codex/responses',
        headers: {},
        connectTimeoutMs: 1_000,
      })).rejects.toMatchObject({ code: 'WS_RETRYABLE' })
      expect(destinations).toEqual(['chatgpt.com:443'])
    } finally {
      await new Promise<void>((resolve, reject) => {
        proxy.close(error => { if (error) reject(error); else resolve() })
      })
    }
  })

  it('validates endpoint conversion without inventing a subprotocol', () => {
    expect(nativeCodexWebSocketUrl('https://chatgpt.com/backend-api/codex/responses'))
      .toBe('wss://chatgpt.com/backend-api/codex/responses')
    expect(nativeCodexWebSocketUrl('http://127.0.0.1:1234/responses'))
      .toBe('ws://127.0.0.1:1234/responses')
    expect(() => nativeCodexWebSocketUrl('file:///tmp/socket'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARGS' }))
    expect(() => nativeCodexWebSocketUrl('ws://example.com/responses'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARGS' }))
    expect(() => nativeCodexWebSocketUrl('ws://127.attacker.example/responses'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ARGS' }))
  })
})
