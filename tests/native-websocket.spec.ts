import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  LlmError,
  createAssistantMessage,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { NATIVE_CODEX_PROVIDER } from '../src/native-adapter.ts'
import { NativeCodexWebSocketTransport } from '../src/native-websocket.ts'
import {
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

afterEach(() => { vi.restoreAllMocks() })

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
      JSON.stringify({ type: 'error', error: { code: 'websocket_connection_limit_reached' } }),
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
    expect(error).toMatchObject({ code: 'WS_RETRYABLE_RESET' })
    expect(secondFetch).not.toHaveBeenCalled()
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

  it('uses one startup prewarm plus two normal reconnects before sticky fallback', async () => {
    const factory = new ScriptedFactory([
      new LlmError('one', 'WS_RETRYABLE'),
      new LlmError('two', 'WS_RETRYABLE'),
      new LlmError('three', 'WS_RETRYABLE'),
      new LlmError('four', 'WS_RETRYABLE'),
    ])
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: factory,
      fetch: fetchMock as typeof fetch,
    })
    await collect(transport.stream(firstRequest()))
    await collect(transport.stream(firstRequest()))
    expect(factory.options).toHaveLength(4)
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
        headers: { 'Retry-After': '2', 'X-Request-Id': ['req-ws-rate'] },
        error: { message: 'bounded' },
      }),
    ])
    const fetchMock = vi.fn(async () => response())
    const transport = new NativeCodexWebSocketTransport({
      resolveCredential: async () => CREDENTIAL,
      webSocketFactory: new ScriptedFactory([scripted]),
      fetch: fetchMock as typeof fetch,
    })
    await expect(collect(transport.stream(firstRequest()))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      failure: { status: 429, providerRetryAfterMs: 2_000, requestId: 'req-ws-rate' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
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
