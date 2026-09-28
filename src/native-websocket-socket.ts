/** Node WebSocket client seam with injectable deterministic factories. */
import { LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { IncomingHttpHeaders } from 'node:http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getProxyForUrl } from 'proxy-from-env'
import { nativeCodexEndpoint } from './endpoint.js'
import {
  NATIVE_CODEX_CONNECTION_FAILED_CODE,
  isNativeCodexConnectionFailure,
} from './native-adapter.js'
import WebSocket from 'ws'

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

export type NativeCodexWebSocketFrame =
  | { type: 'text'; text: string }
  | { type: 'close'; code: number; reason: string }

export interface NativeCodexWebSocket {
  readonly responseHeaders: Readonly<Record<string, string>>
  send(text: string, signal?: AbortSignal): Promise<void>
  receive(signal?: AbortSignal): Promise<NativeCodexWebSocketFrame>
  /** Observe incoming payload bytes while a logical inference owns the socket. */
  observeActivity?(observer: (bytes: number) => void): () => void
  close(): void
}

export interface NativeCodexWebSocketConnectOptions {
  url: string
  headers: Record<string, string>
  signal?: AbortSignal
  connectTimeoutMs?: number
}

export interface NativeCodexWebSocketFactory {
  connect(options: NativeCodexWebSocketConnectOptions): Promise<NativeCodexWebSocket>
}

function failure(message: string, code: string, cause?: unknown): LlmError {
  return new LlmError(message, code, cause === undefined ? undefined : { cause })
}

function abortFailure(signal?: AbortSignal): LlmError {
  return signal?.reason instanceof LlmError
    ? signal.reason
    : failure('native Codex WebSocket request was aborted', 'ABORTED')
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

/** Resolve the same opt-in environment proxy contract used by Node fetch. */
export function nativeCodexWebSocketProxy(endpoint: string): string | undefined {
  if (process.env.NODE_USE_ENV_PROXY !== '1') return undefined
  const proxy = getProxyForUrl(nativeCodexEndpoint(endpoint, true).toString())
  return proxy.length === 0 ? undefined : proxy
}

export function nativeCodexWebSocketUrl(endpoint: string): string {
  const url = nativeCodexEndpoint(endpoint, true)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  return url.toString()
}

class NodeNativeCodexWebSocket implements NativeCodexWebSocket {
  private readonly queue: Array<NativeCodexWebSocketFrame | LlmError> = []
  private readonly waiters: Array<{
    resolve: (frame: NativeCodexWebSocketFrame) => void
    reject: (error: unknown) => void
  }> = []
  private ended = false
  private activityObserver: ((bytes: number) => void) | undefined

  observeActivity(observer: (bytes: number) => void): () => void {
    this.activityObserver = observer
    return () => { if (this.activityObserver === observer) this.activityObserver = undefined }
  }

  constructor(
    private readonly socket: WebSocket,
    readonly responseHeaders: Readonly<Record<string, string>>,
  ) {
    socket.on('ping', data => { this.activityObserver?.(data.byteLength) })
    socket.on('pong', data => { this.activityObserver?.(data.byteLength) })
    socket.on('message', (data, isBinary) => {
      this.activityObserver?.(Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength)
      if (isBinary) {
        this.fail(failure('native Codex WebSocket returned a binary frame', 'WS_PROTOCOL_ERROR'))
        return
      }
      const buffer = Array.isArray(data) ? Buffer.concat(data)
        : Buffer.isBuffer(data) ? data : Buffer.from(data)
      this.push({ type: 'text', text: buffer.toString('utf8') })
    })
    socket.on('close', (code, reason) => {
      this.ended = true
      this.push({ type: 'close', code, reason: reason.subarray(0, 256).toString('utf8') })
    })
    socket.on('error', (error) => {
      this.fail(failure('native Codex WebSocket transport failed', 'WS_RETRYABLE', error))
    })
  }

  private push(value: NativeCodexWebSocketFrame | LlmError): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      if (value instanceof LlmError) waiter.reject(value)
      else waiter.resolve(value)
      return
    }
    this.queue.push(value)
  }

  private fail(error: LlmError): void {
    if (!this.ended) this.socket.terminate()
    this.ended = true
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
    this.queue.length = 0
    if (waiters.length === 0) this.queue.push(error)
  }

  async send(text: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortFailure(signal)
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) {
      throw failure('native Codex WebSocket is closed', 'WS_RETRYABLE')
    }
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        this.socket.terminate()
        reject(abortFailure(signal))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.socket.send(text, (error) => {
        signal?.removeEventListener('abort', abort)
        if (error === undefined || error === null) resolve()
        else reject(failure('native Codex WebSocket send failed', 'WS_RETRYABLE', error))
      })
    })
  }

  async receive(signal?: AbortSignal): Promise<NativeCodexWebSocketFrame> {
    if (signal?.aborted) throw abortFailure(signal)
    const queued = this.queue.shift()
    if (queued !== undefined) {
      if (queued instanceof LlmError) throw queued
      return queued
    }
    return new Promise((resolve, reject) => {
      let waiter!: (typeof this.waiters)[number]
      const abort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        this.socket.terminate()
        reject(abortFailure(signal))
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
    if (options.signal?.aborted) throw abortFailure(options.signal)
    return new Promise((resolve, reject) => {
      const responseHeaders: Record<string, string> = {}
      const proxy = nativeCodexWebSocketProxy(options.url)
      const agent = proxy === undefined ? undefined : new HttpsProxyAgent(proxy)
      const socket = new WebSocket(nativeCodexWebSocketUrl(options.url), {
        headers: options.headers,
        ...(agent === undefined ? {} : { agent }),
        handshakeTimeout: timeout,
        // ws uses zero to disable its default message-size ceiling.
        maxPayload: 0,
        perMessageDeflate: true,
      })
      const abort = (): void => {
        socket.terminate()
        reject(abortFailure(options.signal))
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
        resolve(new NodeNativeCodexWebSocket(socket, responseHeaders))
      })
      socket.on('error', (error) => {
        options.signal?.removeEventListener('abort', abort)
        if (isNativeCodexConnectionFailure(error)) {
          reject(failure(
            'native Codex WebSocket connection failed', NATIVE_CODEX_CONNECTION_FAILED_CODE, error,
          ))
          return
        }
        reject(failure('native Codex WebSocket handshake failed', 'WS_HANDSHAKE', error))
      })
    })
  }
}
