import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { NativeCodexHttpTransport } from '../src/native-http.ts'
import { NATIVE_CODEX_PROVIDER } from '../src/native-adapter.ts'
import { nativeCodexAuthorityHash, type NativeCodexCredential } from '../src/catalog.ts'

const SUCCESS_SSE = await readFile(
  new URL('./fixtures/responses-text-usage.sse', import.meta.url),
  'utf8',
)
const CREDENTIAL: NativeCodexCredential = {
  accessToken: 'synthetic-access-secret',
  accountId: 'acct_synthetic',
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'openai-codex-native',
    model: 'gpt-test',
    messages: [],
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function successResponse(body = SUCCESS_SSE): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_synthetic' },
  })
}

async function loopback(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('loopback server has no TCP address')
  return {
    url: 'http://127.0.0.1:' + String(address.port) + '/backend-api/codex/responses',
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('NativeCodexHttpTransport', () => {
  it('cleans watchdog timers when the stream consumer returns early', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"type":"response.output_text.delta","item_id":"msg-early","delta":"partial"}',
          '', '',
        ].join('\n')))
      },
      cancel() { cancelled = true },
    })
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: (async () => new Response(body, { status: 200 })) as typeof fetch,
      requestTimeoutMs: 5_000,
      streamIdleTimeoutMs: 5_000,
    })
    const iterator = transport.stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'block-start', index: 0, blockType: 'text' },
      done: false,
    })
    await iterator.return?.()
    expect(cancelled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects non-loopback plaintext credential endpoints', () => {
    for (const endpoint of [
      'http://example.com/backend-api/codex/responses',
      'http://127.attacker.example/backend-api/codex/responses',
      'https://attacker.example/backend-api/codex/responses',
    ]) {
      expect(() => new NativeCodexHttpTransport({
        endpoint,
        resolveCredential: async () => CREDENTIAL,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_ARGS' }))
    }
  })
  it('captures sticky turn state from HTTP response headers', async () => {
    const capture = vi.fn()
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: (async () => new Response(SUCCESS_SSE, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-cOdEx-TuRn-StAtE': 'header-sticky',
        },
      })) as typeof fetch,
    })
    await collect(transport.stream(request(), { captureTurnState: capture }))
    expect(capture).toHaveBeenCalledWith('header-sticky')
  })

  it('captures response.metadata turn state for a safe HTTP retry', async () => {
    const seenHeaders: Headers[] = []
    const capture = vi.fn()
    let attempt = 0
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      maxTransientRetries: 1,
      initialRetryDelayMs: 1,
      sleep: async () => {},
      fetch: (async (_input, init) => {
        seenHeaders.push(new Headers(init?.headers))
        attempt += 1
        if (attempt === 1) {
          return successResponse([
            'data: {"type":"response.metadata","headers":{"X-Codex-Turn-State":["http-sticky"]}}',
            '', '',
          ].join('\n'))
        }
        return successResponse()
      }) as typeof fetch,
    })
    await collect(transport.stream(request(), { captureTurnState: capture }))
    expect(capture).toHaveBeenCalledWith('http-sticky')
    expect(seenHeaders).toHaveLength(2)
    expect(seenHeaders[0]?.get('x-codex-turn-state')).toBeNull()
    expect(seenHeaders[1]?.get('x-codex-turn-state')).toBe('http-sticky')
  })

  it('posts the exact stable routed Standard request through a loopback server', async () => {
    let captured: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string } | undefined
    const server = await loopback(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      captured = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(SUCCESS_SSE)
    })
    const completed = vi.fn()
    const resolveCredential = vi.fn(async () => CREDENTIAL)
    const transport = new NativeCodexHttpTransport({
      endpoint: server.url,
      resolveCredential,
      readImage: async () => ({ data: Uint8Array.from([1, 2, 3]) }),
      onCompleted: completed,
    })
    try {
      const chunks = await collect(transport.stream(request({
        sessionId: 'private-session-id' as GenerateOptions['sessionId'],
        system: 'explicit system',
        reasoningEffort: 'medium' as GenerateOptions['reasoningEffort'],
        purpose: 'compaction',
        tools: [{
          name: 'lookup', description: 'Lookup a key',
          parameters: { type: 'object', properties: { key: { type: 'string' } } },
        }],
        messages: [
          { role: 'user', content: [
            { type: 'text', text: 'inspect' },
            { type: 'image', attachment: {
              attachmentId: 'attachment-captured', mediaType: 'image/png', bytes: 3,
              width: 1, height: 1,
            } },
          ] },
          { role: 'assistant', content: [{
            type: 'tool-call', id: 'call_synthetic', name: 'lookup', arguments: '{"key":"safe"}',
          }] },
          { role: 'user', content: [{
            type: 'tool-result', toolCallId: 'call_synthetic', content: [
              { type: 'text', text: 'found' },
            ],
          }] },
        ] as unknown as GenerateOptions['messages'],
      })))
      expect(chunks).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Hello' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
        {
          type: 'usage',
          usage: {
            inputTokens: 6,
            outputTokens: 3,
            cacheReadTokens: 4,
            cacheWriteTokens: 2,
            reasoningTokens: 1,
          },
        },
        {
          type: 'finish',
          reason: { kind: 'stop' },
          replayState: {
            kind: 'openai-codex-native.responses-replay',
            version: 1,
            provider: NATIVE_CODEX_PROVIDER,
            model: 'gpt-test',
            items: [{ type: 'message', id: 'msg_redacted', blocks: [0] }],
          },
        },
      ])
      expect(captured).toBeDefined()
      expect(captured!.method).toBe('POST')
      expect(captured!.url).toBe('/backend-api/codex/responses')
      expect(captured!.headers.authorization).toBe('Bearer ' + CREDENTIAL.accessToken)
      expect(captured!.headers['chatgpt-account-id']).toBe(CREDENTIAL.accountId)
      expect(captured!.headers.originator).toBe('dsh')
      expect(captured!.headers.accept).toBe('text/event-stream')
      expect(captured!.headers['content-type']).toBe('application/json')
      expect(captured!.headers['user-agent']).toContain('deepseek-harness/')
      const routingId = String(captured!.headers['session-id'])
      expect(routingId).toBe('private-session-id')
      expect(captured!.headers['thread-id']).toBe(routingId)
      expect(captured!.headers['x-client-request-id']).toBe(routingId)
      expect(captured!.headers['x-codex-routing-hint']).toBe('model=gpt-test')
      expect(captured!.headers['x-openai-subagent']).toBe('compact')
      const body = JSON.parse(captured!.body)
      const promptCacheKey = String(body.prompt_cache_key)
      expect(promptCacheKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(promptCacheKey).not.toBe(routingId)
      expect(body).toEqual({
        model: 'gpt-test',
        instructions: 'explicit system',
        input: [
          { type: 'message', role: 'user', content: [
            { type: 'input_text', text: 'inspect' },
            { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
          ] },
          {
            type: 'function_call', call_id: 'call_synthetic',
            name: 'lookup', arguments: '{"key":"safe"}',
          },
          { type: 'function_call_output', call_id: 'call_synthetic', output: 'found' },
        ],
        tools: [{
          type: 'function', name: 'lookup', description: 'Lookup a key',
          parameters: { type: 'object', properties: { key: { type: 'string' } } },
        }],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: { effort: 'medium', summary: 'auto' },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: promptCacheKey,
      })
      expect(body).not.toHaveProperty('service_tier')
      expect(resolveCredential).toHaveBeenCalledTimes(1)
      expect(completed).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })

  it('keeps raw routing and private prompt-cache identities stable', async () => {
    const routes: Array<{ header: string; cache: string }> = []
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const body = JSON.parse(String(init?.body))
      routes.push({ header: headers.get('session-id') ?? '', cache: body.prompt_cache_key })
      return successResponse()
    })
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
    })
    const sessionA = 'private-session-a' as GenerateOptions['sessionId']
    const sessionB = 'private-session-b' as GenerateOptions['sessionId']

    await collect(transport.stream(request({ sessionId: sessionA })))
    await collect(transport.stream(request({ sessionId: sessionA })))
    await collect(transport.stream(request({ sessionId: sessionB })))

    expect(routes[0]).toEqual(routes[1])
    expect(routes[0]).not.toEqual(routes[2])
    expect(routes.map(route => route.header)).toEqual([
      'private-session-a', 'private-session-a', 'private-session-b',
    ])
    expect(routes.every(route => route.header !== route.cache)).toBe(true)
  })

  it('keeps Standard/Fast identity stable and Fast retry immutable', async () => {
    const captured: Array<{ headers: Headers; body: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      return captured.length === 2 ? new Response('', { status: 503 }) : successResponse()
    })
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
      maxTransientRetries: 1,
      sleep: async () => {},
    })
    const generation = request({
      sessionId: 'stable-session' as GenerateOptions['sessionId'],
    })

    await collect(transport.stream(generation))
    await collect(transport.stream(generation, {
      serviceTier: 'priority', publicModel: 'gpt-test-fast',
      authorityHash: nativeCodexAuthorityHash(CREDENTIAL.accountId),
    }))

    expect(captured).toHaveLength(3)
    expect(captured.map(row => ({
      session: row.headers.get('session-id'),
      thread: row.headers.get('thread-id'),
      request: row.headers.get('x-client-request-id'),
      cache: row.body.prompt_cache_key,
      model: row.body.model,
    }))).toEqual(Array.from({ length: 3 }, () => ({
      session: 'stable-session',
      thread: 'stable-session',
      request: 'stable-session',
      cache: captured[0]?.body.prompt_cache_key,
      model: 'gpt-test',
    })))
    expect(captured[0]?.body).not.toHaveProperty('service_tier')
    expect(captured[0]?.headers.get('x-codex-routing-hint')).toBe('model=gpt-test')
    for (const row of captured.slice(1)) {
      expect(row.body.service_tier).toBe('priority')
      expect(row.headers.get('x-codex-routing-hint')).toBe('model=gpt-test;tier=priority')
      expect(JSON.stringify(row.body)).not.toContain('gpt-test-fast')
    }
    expect(captured[1]?.body).toEqual(captured[2]?.body)
  })

  it('refuses Fast before fetch when catalog and request accounts differ', async () => {
    const fetchMock = vi.fn(async () => successResponse())
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => ({ accessToken: 'token-b', accountId: 'account-b' }),
      fetch: fetchMock as typeof fetch,
    })
    await expect(collect(transport.stream(request(), {
      serviceTier: 'priority',
      publicModel: 'gpt-test-fast',
      authorityHash: nativeCodexAuthorityHash('account-a'),
    }))).rejects.toMatchObject({ code: 'FAST_CAPABILITY_UNAVAILABLE' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('permits same-account Fast 401 recovery but refuses an account switch', async () => {
    const sameAccountCredentials = [
      { accessToken: 'old-token', accountId: 'account-a' },
      { accessToken: 'new-token', accountId: 'account-a' },
    ]
    const sameBodies: string[] = []
    const sameFetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      sameBodies.push(String(init?.body))
      return sameBodies.length === 1 ? new Response('', { status: 401 }) : successResponse()
    })
    let sameIndex = 0
    const sameTransport = new NativeCodexHttpTransport({
      resolveCredential: async () => sameAccountCredentials[Math.min(sameIndex++, 1)]!,
      recoverCredential: async () => true,
      fetch: sameFetch as typeof fetch,
    })
    const mode = {
      serviceTier: 'priority' as const,
      publicModel: 'gpt-test-fast',
      authorityHash: nativeCodexAuthorityHash('account-a'),
    }
    await expect(collect(sameTransport.stream(request(), mode))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'finish' })]),
    )
    expect(sameBodies).toHaveLength(2)
    expect(sameBodies[0]).toBe(sameBodies[1])

    const switchedCredentials = [
      { accessToken: 'old-token', accountId: 'account-a' },
      { accessToken: 'new-token', accountId: 'account-b' },
    ]
    let switchedIndex = 0
    const switchedFetch = vi.fn(async () => new Response('', { status: 401 }))
    const switchedTransport = new NativeCodexHttpTransport({
      resolveCredential: async () => switchedCredentials[Math.min(switchedIndex++, 1)]!,
      recoverCredential: async () => true,
      fetch: switchedFetch as typeof fetch,
    })
    await expect(collect(switchedTransport.stream(request(), mode)))
      .rejects.toMatchObject({ code: 'FAST_CAPABILITY_UNAVAILABLE' })
    expect(switchedFetch).toHaveBeenCalledTimes(1)
  })

  it('resolves attachment bytes into a verified user image data URL', async () => {
    let body: any
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return successResponse()
    })
    const readImage = vi.fn(async () => ({ data: Uint8Array.from([1, 2, 3]) }))
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
      readImage,
    })
    const attachment = {
      attachmentId: 'attachment-synthetic',
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    }
    await collect(transport.stream(request({
      messages: [{
        id: 'message-synthetic',
        role: 'user',
        content: [{ type: 'image', attachment }],
        source: { kind: 'user' },
      }] as unknown as GenerateOptions['messages'],
    })))

    expect(readImage).toHaveBeenCalledTimes(1)
    expect(body.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
    }])
  })

  it('replays captured encrypted reasoning and function state on the next tool turn', async () => {
    const toolSse = await readFile(
      new URL('./fixtures/responses-tool-reasoning.sse', import.meta.url),
      'utf8',
    )
    const bodies: Array<Record<string, any>> = []
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return bodies.length === 1 ? successResponse(toolSse) : successResponse()
    })
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
    })
    const first = await collect(transport.stream(request()))
    const finish = first.find(chunk => chunk.type === 'finish')
    if (finish?.type !== 'finish' || finish.replayState === undefined) {
      throw new Error('first turn did not produce replay state')
    }

    await collect(transport.stream(request({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Checked safely.' },
            { type: 'tool-call', id: 'call_redacted', name: 'lookup', arguments: '{"key":"safe"}' },
          ],
          source: {
            kind: 'model', provider: NATIVE_CODEX_PROVIDER, model: 'gpt-test',
            replayState: JSON.parse(JSON.stringify(finish.replayState)),
          },
        },
        {
          role: 'user',
          content: [{
            type: 'tool-result', toolCallId: 'call_redacted',
            content: [{ type: 'text', text: 'found' }],
          }],
          source: { kind: 'tool', callId: 'call_redacted' },
        },
      ] as unknown as GenerateOptions['messages'],
    })))

    expect(bodies[1]?.input).toEqual([
      {
        type: 'reasoning', id: 'reason_redacted',
        summary: [{ type: 'summary_text', text: 'Checked safely.' }],
        encrypted_content: 'encrypted_redacted',
      },
      {
        type: 'function_call', id: 'call_item_redacted', call_id: 'call_redacted',
        name: 'lookup', arguments: '{"key":"safe"}',
      },
      { type: 'function_call_output', call_id: 'call_redacted', output: 'found' },
    ])
    expect(JSON.stringify(finish.replayState)).not.toContain('Checked safely.')
    expect(JSON.stringify(finish.replayState)).not.toContain('lookup')
  })

  it('recovers one rejected credential and re-resolves authority for the retry', async () => {
    let credential = CREDENTIAL
    const seenAuthorization: string[] = []
    const cancelRejected = vi.fn()
    const rejectedBody = new ReadableStream<Uint8Array>({ cancel: cancelRejected })
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      seenAuthorization.push(new Headers(init?.headers).get('authorization') ?? '')
      return seenAuthorization.length === 1
        ? new Response(rejectedBody, { status: 401 })
        : successResponse()
    })
    const recoverCredential = vi.fn(async () => {
      credential = { accessToken: 'synthetic-rotated-secret', accountId: 'acct_rotated' }
      return true
    })
    const resolveCredential = vi.fn(async () => credential)
    const transport = new NativeCodexHttpTransport({
      resolveCredential,
      recoverCredential,
      fetch: fetchMock as typeof fetch,
    })

    await expect(collect(transport.stream(request()))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
      ]),
    )
    expect(recoverCredential).toHaveBeenCalledTimes(1)
    expect(cancelRejected).toHaveBeenCalledTimes(1)
    expect(resolveCredential).toHaveBeenCalledTimes(2)
    expect(seenAuthorization).toEqual([
      'Bearer ' + CREDENTIAL.accessToken,
      'Bearer synthetic-rotated-secret',
    ])
  })

  it('attempts credential recovery only once before returning AUTH', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }))
    const recoverCredential = vi.fn(async () => true)
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      recoverCredential,
      fetch: fetchMock as typeof fetch,
    })

    const error = await collect(transport.stream(request())).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ code: 'AUTH', failure: { status: 401 } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(recoverCredential).toHaveBeenCalledTimes(1)
  })

  it('retries transient HTTP establishment with bounded exponential delays', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"code":"server_is_overloaded"}}', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(successResponse())
    const delays: number[] = []
    const resolveCredential = vi.fn(async () => CREDENTIAL)
    const transport = new NativeCodexHttpTransport({
      resolveCredential,
      fetch: fetchMock as typeof fetch,
      maxTransientRetries: 2,
      random: () => 0.5,
      sleep: async delay => { delays.push(delay) },
    })

    await collect(transport.stream(request()))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(resolveCredential).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([200, 400])
  })

  it('cancels promptly while waiting for transient backoff', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }))
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
      initialRetryDelayMs: 10_000,
      maxTransientRetries: 1,
    })
    const pending = collect(transport.stream(request({ signal: controller.signal })))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry rate limits and retains bounded provider facts without secrets', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '{"error":{"code":"rate_limit_exceeded","message":"try later"}}',
      { status: 429, headers: { 'retry-after': '2', 'x-request-id': 'req-rate' } },
    ))
    const sleepMock = vi.fn(async () => {})
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
      sleep: sleepMock,
    })

    const error = await collect(transport.stream(request())).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      code: 'RATE_LIMIT',
      failure: { status: 429, providerRetryAfterMs: 2000, requestId: 'req-rate' },
    })
    expect(JSON.stringify(error)).not.toContain(CREDENTIAL.accessToken)
    expect(JSON.stringify(error)).not.toContain(CREDENTIAL.accountId)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  it('retries a stream close only before any DSH chunk is visible', async () => {
    const malformedOnly = 'data: {not-json}\n\n'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(successResponse(malformedOnly))
      .mockResolvedValueOnce(successResponse())
    const delays: number[] = []
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
      maxTransientRetries: 1,
      random: () => 0.5,
      sleep: async delay => { delays.push(delay) },
    })

    await expect(collect(transport.stream(request()))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
      ]),
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([200])
  })

  it('discards failed-attempt encrypted replay capture before retry', async () => {
    const failedAttempt = [
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_failed","summary":[],"encrypted_content":"failed_attempt_ciphertext"}}',
      '',
      '',
    ].join('\n')
    const successfulAttempt = await readFile(
      new URL('./fixtures/responses-tool-reasoning.sse', import.meta.url),
      'utf8',
    )
    let attempts = 0
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: vi.fn(async () => successResponse(attempts++ === 0 ? failedAttempt : successfulAttempt)) as typeof fetch,
      maxTransientRetries: 1,
      sleep: async () => {},
    })

    const chunks = await collect(transport.stream(request()))
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(JSON.stringify(finish)).toContain('encrypted_redacted')
    expect(JSON.stringify(finish)).not.toContain('failed_attempt_ciphertext')
    expect(attempts).toBe(2)
  })

  it('never retries after a visible block and preserves the stream-close failure', async () => {
    const partial = 'data: {"type":"response.output_text.delta","item_id":"msg-partial","delta":"part"}\n\n'
    const fetchMock = vi.fn(async () => successResponse(partial))
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
      maxTransientRetries: 4,
      sleep: async () => { throw new Error('must not retry') },
    })
    const chunks: StreamChunk[] = []
    let error: unknown
    try {
      for await (const chunk of transport.stream(request())) chunks.push(chunk)
    } catch (reason) {
      error = reason
    }

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'part' },
    ])
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ code: 'STREAM_CLOSED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects attachment, body, and SSE resource violations deterministically', async () => {
    const attachment = {
      attachmentId: 'attachment-invalid', mediaType: 'image/png', bytes: 3,
      width: 1, height: 1,
    }
    const generation = request({ messages: [{
      role: 'user', content: [{ type: 'image', attachment }],
    }] as unknown as GenerateOptions['messages'] })
    const withoutStore = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
    })
    await expect(collect(withoutStore.stream(generation))).rejects.toMatchObject({ code: 'UNSUPPORTED' })

    const mismatched = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      readImage: async () => ({ data: Uint8Array.from([1, 2]) }),
    })
    await expect(collect(mismatched.stream(generation)))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' })

    const invalidSession = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
    })
    await expect(collect(invalidSession.stream(request({
      sessionId: 'invalid\nsession' as GenerateOptions['sessionId'],
    })))).rejects.toMatchObject({ code: 'INVALID_ARGS' })

    const oversizedRequest = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      maxRequestBodyBytes: 1,
    })
    await expect(collect(oversizedRequest.stream(request())))
      .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })

    const bodyless = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch,
    })
    await expect(collect(bodyless.stream(request()))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })

    const oversizedSse = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: vi.fn(async () => successResponse()) as typeof fetch,
      maxSseEventBytes: 16,
      maxTransientRetries: 0,
    })
    await expect(collect(oversizedSse.stream(request())))
      .rejects.toMatchObject({ code: 'SSE_EVENT_TOO_LARGE' })
  })

  it('preserves caller abort and request timeout during active network reads', async () => {
    const controller = new AbortController()
    const cancelErrorBody = vi.fn()
    const errorBody = new ReadableStream<Uint8Array>({ cancel: cancelErrorBody })
    const errorFetch = vi.fn(async () => new Response(errorBody, { status: 400 }))
    const activeError = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: errorFetch as typeof fetch,
      requestTimeoutMs: 1_000,
      maxTransientRetries: 0,
    })
    const pending = collect(activeError.stream(request({ signal: controller.signal })))
    await vi.waitFor(() => expect(errorFetch).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(cancelErrorBody).toHaveBeenCalledTimes(1)

    const timeoutFetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('synthetic abort')) }, { once: true })
      }))
    const timed = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: timeoutFetch as typeof fetch,
      requestTimeoutMs: 5,
      maxTransientRetries: 0,
    })
    await expect(collect(timed.stream(request()))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('classifies idle expiry as timeout and caller cancellation as aborted', async () => {
    const cancel = vi.fn()
    const hanging = new ReadableStream<Uint8Array>({ cancel })
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => CREDENTIAL,
      fetch: vi.fn(async () => new Response(hanging)) as typeof fetch,
      requestTimeoutMs: 100,
      streamIdleTimeoutMs: 5,
      maxTransientRetries: 0,
    })
    const timeout = await collect(transport.stream(request())).catch((reason: unknown) => reason)
    expect(timeout).toBeInstanceOf(LlmError)
    expect(timeout).toMatchObject({ code: 'TIMEOUT' })
    expect(cancel).toHaveBeenCalledTimes(1)

    const resolveCredential = vi.fn(async () => CREDENTIAL)
    const preCancelled = new AbortController()
    preCancelled.abort()
    const cancelled = new NativeCodexHttpTransport({ resolveCredential })
    const error = await collect(cancelled.stream(request({ signal: preCancelled.signal })))
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ code: 'ABORTED' })
    expect(resolveCredential).not.toHaveBeenCalled()
  })
})
