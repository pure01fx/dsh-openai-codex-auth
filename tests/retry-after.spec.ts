import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonRetryAfterMs, retryAfterMs, retryError, remainingRetryDelay, sleepRetry } from '../src/retry-after.ts'
import { responsesFailure, ResponsesStreamTranslator } from '../src/responses.ts'
import { NativeCodexHttpTransport } from '../src/native-http.ts'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('upstream Retry-After alignment', () => {
  it.each(['1.5', '-2', '+2', '1e3', '', 'Infinity', '\n5\n', '99999999999999999999'])('rejects invalid seconds %j', value => {
    expect(retryAfterMs(value)).toBeUndefined()
  })
  it.each([
    'Fri, 31 Feb 2020 08:49:37 GMT',
    'Friday, 31-Feb-20 08:49:37 GMT',
    'Fri Feb 31 08:49:37 2020',
    'Mon, 06 Nov 1994 08:49:37 GMT',
  ])('rejects impossible calendar or weekday dates %j', value => {
    expect(retryAfterMs(value)).toBeUndefined()
  })

  it('accepts numeric JSON, zero, header validation and duplicate precedence', () => {
    expect(jsonRetryAfterMs({ 'Retry-After': 300 })).toBe(300_000)
    expect(jsonRetryAfterMs({ 'retry-after': ['5'] })).toBeUndefined()
    expect(jsonRetryAfterMs({ 'retry-after': '\t5\t' })).toBe(5_000)
    expect(jsonRetryAfterMs({ 'retry-after': '30', 'Retry-After': '5' })).toBe(30_000)
    expect(retryAfterMs('0')).toBe(0)
  })
  it('accepts all HTTP-date forms and expired advice', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('Sun, 06 Nov 1994 08:44:37 GMT'))
    for (const value of ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994']) expect(retryAfterMs(value)).toBe(300_000)
    expect(retryAfterMs('Sun, 06 Nov 1994 08:40:37 GMT')).toBe(0)
  })
  it('preserves one monotonic deadline across wrappers and repeated waits', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const error = retryError('retry', 'SERVER', { providerRetryAfterMs: 300_000 })
    clock.mockReturnValue(60_100)
    const wrapped = retryError('wrapped', 'SERVER', { cause: error, providerRetryAfterMs: 300_000 })
    expect(remainingRetryDelay(wrapped)).toBe(240_000)
    clock.mockReturnValue(300_100)
    expect(remainingRetryDelay(wrapped)).toBe(0)
    const zero = retryError('zero', 'SERVER', { providerRetryAfterMs: 0 })
    expect(zero.failure.providerRetryAfterMs).toBeUndefined()
    expect(remainingRetryDelay(zero)).toBe(0)
  })
  it('chunks timer-overflow waits and remains abortable', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let done = false
    const pending = sleepRetry(3_000_000_000, controller.signal).then(() => { done = true })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(false)
    controller.abort()
    await rejected
  })
  it('reads nested failed response headers before message advice', () => {
    const translator = new ResponsesStreamTranslator()
    expect(() => translator.push({ type: 'response.failed', response: { error: {
      code: 'slow_down', message: 'Try again in 1s', headers: { 'Retry-After': 300 },
    } } })).toThrow(expect.objectContaining({ failure: expect.objectContaining({ providerRetryAfterMs: 300_000 }) }))
    expect(responsesFailure('server_is_overloaded', 'Try again in 5s').failure.providerRetryAfterMs).toBeUndefined()
    expect(responsesFailure('slow_down', 'Try again in 900s').failure.providerRetryAfterMs).toBe(900_000)
  })
  it('preserves advice when decoding the HTTP error body times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const delays: number[] = []
    let attempt = 0
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => ({ accessToken: 'token', accountId: 'account' }),
      requestTimeoutMs: 10, maxTransientRetries: 1, maxRetryDelayMs: 100,
      sleep: async delay => { delays.push(delay) },
      fetch: async () => ++attempt === 1
        ? new Response(new ReadableStream(), { status: 503, headers: { 'Retry-After': '300' } })
        : new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'),
    })
    const pending = (async () => {
      for await (const _chunk of transport.stream({ provider: 'openai-codex-native', model: 'test', messages: [] })) { /* drain */ }
    })()
    await vi.advanceTimersByTimeAsync(10)
    await pending
    expect(delays).toEqual([300_000])
  })

  it('consumes HTTP advice during error-body decoding and honors later advice independently', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const delays: number[] = []
    let attempt = 0
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => ({ accessToken: 'token', accountId: 'account' }),
      maxTransientRetries: 2, maxRetryDelayMs: 100,
      sleep: async delay => { delays.push(delay); clock.mockReturnValue(performance.now() + delay) },
      fetch: async () => {
        attempt++
        if (attempt === 3) return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n')
        return new Response(new ReadableStream({ pull(controller) {
          clock.mockReturnValue(performance.now() + 60_000)
          controller.enqueue(new TextEncoder().encode('{"error":{"code":"server_error"}}'))
          controller.close()
        } }, { highWaterMark: 0 }), { status: 503, headers: { 'Retry-After': '300' } })
      },
    })
    for await (const _chunk of transport.stream({ provider: 'openai-codex-native', model: 'test', messages: [] })) { /* drain */ }
    expect(delays).toEqual([240_000, 240_000])
  })
})
