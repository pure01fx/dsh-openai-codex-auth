import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { NativeCodexHttpTransport } from '../src/native-http.ts'
import type { NativeCodexCredential } from '../src/catalog.ts'

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
})

describe('NativeCodexHttpTransport', () => {
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
        { type: 'finish', reason: { kind: 'stop' } },
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

    await expect(collect(transport.stream(request()))).resolves.toContainEqual({
      type: 'finish', reason: { kind: 'stop' },
    })
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

    await expect(collect(transport.stream(request()))).resolves.toContainEqual({
      type: 'finish', reason: { kind: 'stop' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([200])
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
