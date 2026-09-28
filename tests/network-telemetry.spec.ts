import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { NetworkTelemetry, trackNetwork } from '../src/network-telemetry.ts'
import { NativeCodexHttpTransport } from '../src/native-http.ts'
import { NativeCodexWebSocketTransport } from '../src/native-websocket.ts'

const credential = { accessToken: 'secret-token', accountId: 'private-account' }
const generation: GenerateOptions = { provider: 'openai-codex', model: 'test', messages: [] }
const success = await readFile(new URL('./fixtures/responses-text-usage.sse', import.meta.url), 'utf8')
async function collect(stream: AsyncIterable<StreamChunk>): Promise<void> { for await (const _chunk of stream) {} }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('network telemetry', () => {
  it('bounds rows without losing concurrent totals and isolates snapshots', async () => {
    const telemetry = new NetworkTelemetry(2)
    const handles = Array.from({ length: 40 }, () => telemetry.begin('http'))
    expect(telemetry.snapshot()).toMatchObject({ activeCount: 40, truncated: true })
    expect(telemetry.snapshot().requests).toHaveLength(2)
    await Promise.all(handles.map(async (handle, index) => {
      await Promise.resolve()
      handle.attempt('http'); handle.activity(index + 1)
      handle.finish(index % 2 ? 'failed' : 'completed')
      handle.finish('cancelled'); handle.activity(999)
    }))
    const snapshot = telemetry.snapshot()
    expect(snapshot.totals).toEqual({ requests: 40, succeeded: 20, failed: 20, cancelled: 0, retries: 0, receivedBytes: 820 })
    expect(snapshot.activeCount).toBe(0)
    snapshot.requests[0]!.state = 'preparing'
    snapshot.totals.requests = 0
    expect(telemetry.snapshot().requests[0]!.state).not.toBe('preparing')
    expect(telemetry.snapshot().totals.requests).toBe(40)
  })

  it('keeps stalled raw activity separate from output and samples current time', async () => {
    let now = 100
    const telemetry = new NetworkTelemetry(8, () => now)
    const controller = deferred<ReadableStreamDefaultController<Uint8Array>>()
    const started = deferred<void>()
    const transport = new NativeCodexHttpTransport({ telemetry, resolveCredential: async () => credential,
      fetch: async () => {
        started.resolve()
        return new Response(new ReadableStream<Uint8Array>({ start: value => controller.resolve(value) }))
      },
    })
    const abort = new AbortController()
    const pending = collect(transport.stream({ ...generation, signal: abort.signal }))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await started.promise
    const body = await controller.promise
    now = 200
    body.enqueue(new TextEncoder().encode(': heartbeat\n\n'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(telemetry.snapshot().requests[0]).toMatchObject({ state: 'waiting', lastActivityAt: 200, lastOutputAt: null, receivedBytes: 13, attempts: 1 })
    now = 30_000
    expect(telemetry.snapshot()).toMatchObject({ updatedAt: 30_000, activeCount: 1 })
    expect(telemetry.snapshot().requests[0]!.lastActivityAt).toBe(200)
    abort.abort()
    await rejected
    expect(telemetry.snapshot()).toMatchObject({ activeCount: 0, totals: { cancelled: 1 } })
  })

  it('exposes actual retry deadline and preserves one logical HTTP request', async () => {
    let now = 1_000
    const telemetry = new NetworkTelemetry(8, () => now)
    const sleeping = deferred<void>()
    const resume = deferred<void>()
    let attempts = 0
    const transport = new NativeCodexHttpTransport({ telemetry, resolveCredential: async () => credential,
      fetch: async () => {
        if (++attempts === 1) throw new TypeError('private error', { cause: Object.assign(new Error('private host'), { code: 'ECONNREFUSED' }) })
        return new Response(success)
      },
      sleep: async delay => { expect(delay).toBe(5_000); sleeping.resolve(); await resume.promise },
    })
    const pending = collect(transport.stream(generation))
    await sleeping.promise
    expect(telemetry.snapshot().requests[0]).toMatchObject({ state: 'retrying', retryKind: 'connection', retryAt: 6_000, retries: 1, attempts: 1, lastOutputAt: null })
    now = 6_000
    resume.resolve()
    await pending
    expect(telemetry.snapshot()).toMatchObject({ activeCount: 0, totals: { requests: 1, succeeded: 1, retries: 1, receivedBytes: Buffer.byteLength(success) } })
    expect(telemetry.snapshot().requests[0]).toMatchObject({ state: 'completed', retryKind: null, retryAt: null, attempts: 2, lastOutputAt: 6_000 })
    expect(JSON.stringify(telemetry.snapshot())).not.toMatch(/secret|private/)
  })

  it('counts WebSocket fallback once, including retries and HTTP bytes', async () => {
    const telemetry = new NetworkTelemetry()
    const transport = new NativeCodexWebSocketTransport({ telemetry, resolveCredential: async () => credential,
      webSocketFactory: { connect: async () => { throw new LlmError('upgrade', 'WS_UPGRADE_REQUIRED') } },
      fetch: async () => new Response(success),
    })
    try { await collect(transport.stream(generation)) } finally { transport.dispose() }
    expect(telemetry.snapshot()).toMatchObject({ activeCount: 0, totals: { requests: 1, succeeded: 1, failed: 0, retries: 1 } })
    expect(telemetry.snapshot().requests[0]).toMatchObject({ state: 'completed', transport: 'http', attempts: 2, receivedBytes: Buffer.byteLength(success) })
  })

  it('tracks invisible WebSocket prewarm and removes raw observer on early return', async () => {
    const telemetry = new NetworkTelemetry()
    let observer: ((bytes: number) => void) | undefined
    let receives = 0
    const transport = new NativeCodexWebSocketTransport({ telemetry, resolveCredential: async () => credential,
      webSocketFactory: { connect: async () => ({ responseHeaders: {}, send: async () => {}, close: () => {},
        observeActivity: callback => { observer = callback; return () => { observer = undefined } },
        receive: async () => {
          const text = ++receives === 1
            ? JSON.stringify({ type: 'response.completed', response: { id: 'hidden-response' } })
            : JSON.stringify({ type: 'response.output_text.delta', item_id: 'hidden-item', delta: 'visible' })
          observer?.(Buffer.byteLength(text))
          if (receives === 1) expect(telemetry.snapshot().requests[0]!.lastOutputAt).toBeNull()
          return { type: 'text', text }
        },
      }) },
    })
    try {
      for await (const chunk of transport.stream(generation)) {
        if (chunk.type !== 'text-delta') continue
        expect(telemetry.snapshot().requests[0]!.lastOutputAt).not.toBeNull()
        observer?.(7)
        break
      }
      expect(observer).toBeUndefined()
      expect(telemetry.snapshot()).toMatchObject({ activeCount: 0, totals: { cancelled: 1, succeeded: 0 } })
    } finally { transport.dispose() }
  })

  it('cleans up preparation failures and generator cancellation', async () => {
    const telemetry = new NetworkTelemetry()
    const transport = new NativeCodexHttpTransport({ telemetry, resolveCredential: async () => credential })
    await expect(collect(transport.stream({ ...generation, model: '' }))).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    for await (const _value of trackNetwork(telemetry, 'http', undefined, async function* () { yield 1 })) break
    expect(telemetry.snapshot()).toMatchObject({ activeCount: 0, totals: { failed: 1, cancelled: 1, requests: 2 } })
  })
})
