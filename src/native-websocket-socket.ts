/** Bounded Node WebSocket client seam with injectable deterministic factories. */
import { LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { IncomingHttpHeaders } from 'node:http'
import { nativeCodexEndpoint } from './endpoint.js'
import WebSocket from 'ws'

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
const MAX_QUEUED_FRAMES = 4096
const MAX_QUEUED_BYTES = 24 * 1024 * 1024

export type NativeCodexWebSocketFrame =
  | { type: 'text'; text: string }
  | { type: 'close'; code: number; reason: string }

export interface NativeCodexWebSocket {
  readonly responseHeaders: Readonly<Record<string, string>>
  send(text: string, signal?: AbortSignal): Promise<void>
  receive(signal?: AbortSignal): Promise<NativeCodexWebSocketFrame>
  close(): void
}

export interface NativeCodexWebSocketConnectOptions {
  url: string
  headers: Record<string, string>
  signal?: AbortSignal
  connectTimeoutMs?: number
  maxFrameBytes?: number
}

export interface NativeCodexWebSocketFactory {
  connect(options: NativeCodexWebSocketConnectOptions): Promise<NativeCodexWebSocket>
}

function failure(message: string, code: string, cause?: unknown): LlmError {
  return new LlmError(message, code, cause === undefined ? undefined : { cause })
}

function handshakeFacts(
  status: number | undefined, headers: IncomingHttpHeaders,
): ConstructorParameters<typeof LlmError>[2] {
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value
  const requestId = first(headers['x-request-id'])
  const retryAfter = Number(first(headers['retry-after']))
  const providerRetryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1_000, 120_000) : undefined
  return {
    ...(status === undefined ? {} : { status }),
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
    ...(requestId === undefined || requestId.length === 0 || requestId.length > 256
      ? {} : { requestId: ProviderRequestId(requestId) }),
  }
}

function positive(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw failure(`native Codex ${label} is invalid`, 'INVALID_ARGS')
  return value
}

export function nativeCodexWebSocketUrl(endpoint: string): string {
  const url = nativeCodexEndpoint(endpoint, true)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  return url.toString()
}

class NodeNativeCodexWebSocket implements NativeCodexWebSocket {
  private readonly queue: Array<{
    value: NativeCodexWebSocketFrame | LlmError
    bytes: number
  }> = []
  private queuedBytes = 0
  private readonly waiters: Array<{
    resolve: (frame: NativeCodexWebSocketFrame) => void
    reject: (error: unknown) => void
  }> = []
  private ended = false

  constructor(
    private readonly socket: WebSocket,
    readonly responseHeaders: Readonly<Record<string, string>>,
    private readonly maxFrameBytes: number,
  ) {
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.fail(failure('native Codex WebSocket returned a binary frame', 'WS_PROTOCOL_ERROR'))
        return
      }
      if (data.byteLength > maxFrameBytes) {
        this.fail(failure('native Codex WebSocket frame exceeded the size limit', 'WS_FRAME_TOO_LARGE'))
        return
      }
      this.push({ type: 'text', text: data.toString('utf8') }, data.byteLength)
    })
    socket.on('close', (code, reason) => {
      this.ended = true
      this.push({ type: 'close', code, reason: reason.subarray(0, 256).toString('utf8') })
    })
    socket.on('error', (error) => {
      this.fail(failure('native Codex WebSocket transport failed', 'WS_RETRYABLE', error))
    })
  }

  private push(value: NativeCodexWebSocketFrame | LlmError, bytes = 0): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      if (value instanceof LlmError) waiter.reject(value)
      else waiter.resolve(value)
      return
    }
    if (this.queue.length >= MAX_QUEUED_FRAMES || this.queuedBytes + bytes > MAX_QUEUED_BYTES) {
      this.fail(failure('native Codex WebSocket queued too much response data', 'WS_RESPONSE_TOO_LARGE'))
      return
    }
    this.queue.push({ value, bytes })
    this.queuedBytes += bytes
  }

  private fail(error: LlmError): void {
    if (!this.ended) this.socket.terminate()
    this.ended = true
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
    this.queue.length = 0
    this.queuedBytes = 0
    if (waiters.length === 0) this.queue.push({ value: error, bytes: 0 })
  }

  async send(text: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw failure('native Codex WebSocket request was aborted', 'ABORTED')
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) {
      throw failure('native Codex WebSocket is closed', 'WS_RETRYABLE')
    }
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        this.socket.terminate()
        reject(failure('native Codex WebSocket request was aborted', 'ABORTED'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.socket.send(text, (error) => {
        signal?.removeEventListener('abort', abort)
        if (error === undefined) resolve()
        else reject(failure('native Codex WebSocket send failed', 'WS_RETRYABLE', error))
      })
    })
  }

  async receive(signal?: AbortSignal): Promise<NativeCodexWebSocketFrame> {
    if (signal?.aborted) throw failure('native Codex WebSocket request was aborted', 'ABORTED')
    const queued = this.queue.shift()
    if (queued !== undefined) {
      this.queuedBytes -= queued.bytes
      if (queued.value instanceof LlmError) throw queued.value
      return queued.value
    }
    return new Promise((resolve, reject) => {
      let waiter!: (typeof this.waiters)[number]
      const abort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        this.socket.terminate()
        reject(failure('native Codex WebSocket request was aborted', 'ABORTED'))
      }
      waiter = {
        resolve: (frame) => { signal?.removeEventListener('abort', abort); resolve(frame) },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error) },
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.waiters.push(waiter)
    })
  }

  close(): void {
    this.ended = true
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'done')
    else this.socket.terminate()
  }
}

export class NodeNativeCodexWebSocketFactory implements NativeCodexWebSocketFactory {
  async connect(options: NativeCodexWebSocketConnectOptions): Promise<NativeCodexWebSocket> {
    const timeout = positive(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'connect timeout')
    const maximum = positive(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 'frame limit')
    if (options.signal?.aborted) throw failure('native Codex WebSocket request was aborted', 'ABORTED')
    return new Promise((resolve, reject) => {
      const responseHeaders: Record<string, string> = {}
      const socket = new WebSocket(nativeCodexWebSocketUrl(options.url), {
        headers: options.headers,
        handshakeTimeout: timeout,
        maxPayload: maximum,
        perMessageDeflate: true,
      })
      const abort = (): void => {
        socket.terminate()
        reject(failure('native Codex WebSocket request was aborted', 'ABORTED'))
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      socket.on('upgrade', (response) => {
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') responseHeaders[key.toLowerCase()] = value
          else if (Array.isArray(value)) responseHeaders[key.toLowerCase()] = value.join(', ')
        }
      })
      socket.on('unexpected-response', (_request, response) => {
        response.resume()
        options.signal?.removeEventListener('abort', abort)
        const code = response.statusCode === 426 ? 'WS_UPGRADE_REQUIRED'
          : response.statusCode === 401 ? 'WS_AUTH'
            : response.statusCode === 403 ? 'AUTH'
              : response.statusCode === 429 ? 'RATE_LIMITED'
                : response.statusCode !== undefined && response.statusCode >= 500
                  ? 'WS_RETRYABLE'
                  : response.statusCode !== undefined && response.statusCode >= 400
                    ? 'INVALID_REQUEST' : 'WS_HANDSHAKE'
        reject(new LlmError(
          `native Codex WebSocket handshake failed (HTTP ${response.statusCode ?? 0})`,
          code,
          handshakeFacts(response.statusCode, response.headers),
        ))
      })
      socket.on('open', () => {
        options.signal?.removeEventListener('abort', abort)
        resolve(new NodeNativeCodexWebSocket(socket, responseHeaders, maximum))
      })
      socket.on('error', (error) => {
        options.signal?.removeEventListener('abort', abort)
        reject(failure('native Codex WebSocket connection failed', 'WS_RETRYABLE', error))
      })
    })
  }
}
