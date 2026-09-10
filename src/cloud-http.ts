/** Bounded, nonstreaming Codex cloud requests. Never retry ambiguous POST failures. */
import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { NativeCodexCredential } from './catalog.js'
import { nativeCodexEndpoint } from './endpoint.js'

export interface NativeCodexCloudOptions {
  resolveCredential(signal?: AbortSignal): Promise<NativeCodexCredential>
  recoverCredential?(previous: NativeCodexCredential, signal?: AbortSignal): Promise<boolean>
  fetch?: typeof fetch
  endpoint?: string
  requestTimeoutMs?: number
  maxRequestBodyBytes?: number
  maxResponseBytes?: number
}
export interface NativeCodexCloudPostOptions {
  credential: NativeCodexCredential
  signal: AbortSignal
  headers?: Record<string, string>
  timeoutMs?: number
  maxResponseBytes?: number
}
export type NativeCodexCloudPath = 'alpha/search' | 'images/generations' | 'images/edits'
const fail = (message: string, code = 'CODEX_CLOUD_FAILED') => new LlmError(message, code)
function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw fail('Invalid cloud request limit', 'INVALID_ARGS')
  return value
}
function credentialCopy(value: NativeCodexCredential): NativeCodexCredential {
  if (!value || typeof value.accessToken !== 'string' || !value.accessToken.trim()
    || typeof value.accountId !== 'string' || !value.accountId.trim()) throw fail('Codex cloud credential unavailable', 'AUTH_REQUIRED')
  return { accessToken: value.accessToken, accountId: value.accountId }
}
/** Race even injected transports/resolvers that do not implement AbortSignal. */
function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('Codex cloud request cancelled or timed out', 'ABORTED'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
export class NativeCodexCloudClient {
  private readonly endpoint: URL
  constructor(private readonly options: NativeCodexCloudOptions) {
    try {
      this.endpoint = nativeCodexEndpoint(options.endpoint ?? 'https://chatgpt.com/backend-api/codex')
      if (this.endpoint.search) throw new Error()
    } catch { throw fail('Invalid Codex cloud endpoint', 'INVALID_ARGS') }
  }
  async resolveCredential(signal?: AbortSignal): Promise<NativeCodexCredential> {
    if (signal?.aborted) throw fail('Codex cloud request cancelled', 'ABORTED')
    try {
      const pending = this.options.resolveCredential(signal)
      return credentialCopy(await (signal ? cancellable(pending, signal) : pending))
    } catch {
      throw fail(signal?.aborted ? 'Codex cloud request cancelled' : 'Codex cloud credential unavailable', signal?.aborted ? 'ABORTED' : 'AUTH_REQUIRED')
    }
  }
  async post(path: NativeCodexCloudPath, body: Record<string, unknown>, options: NativeCodexCloudPostOptions): Promise<{ body: unknown; requestId?: string }> {
    if (!['alpha/search', 'images/generations', 'images/edits'].includes(path)) throw fail('Invalid Codex cloud path', 'INVALID_ARGS')
    const timeoutMs = positive(options.timeoutMs ?? this.options.requestTimeoutMs, 120_000)
    const maxBytes = positive(options.maxResponseBytes ?? this.options.maxResponseBytes, 48 * 1024 * 1024)
    const requestLimit = positive(this.options.maxRequestBodyBytes, 48 * 1024 * 1024)
    let encoded: string
    try { encoded = JSON.stringify(body) } catch { throw fail('Invalid cloud JSON request', 'INVALID_ARGS') }
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > requestLimit) throw fail('Cloud request exceeds byte limit', 'INVALID_ARGS')
    let credential = credentialCopy(options.credential)
    const accountId = credential.accountId
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
    const timer = setTimeout(abort, timeoutMs)
    const signal = controller.signal
    const url = new URL(this.endpoint)
    url.pathname = (url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname) + '/' + path
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) throw fail('Codex cloud request cancelled or timed out', 'ABORTED')
        let response: Response
        try {
          const headers = new Headers({ ...attributionHeaders(), ...options.headers })
          headers.set('authorization', 'Bearer ' + credential.accessToken)
          headers.set('chatgpt-account-id', credential.accountId)
          headers.set('originator', 'dsh')
          headers.set('content-type', 'application/json')
          headers.set('accept', 'application/json')
          response = await cancellable((this.options.fetch ?? fetch)(url.toString(), {
            method: 'POST', redirect: 'error', headers, body: encoded, signal,
          }), signal)
        } catch { throw fail(signal.aborted ? 'Codex cloud request cancelled or timed out' : 'Codex cloud request failed; it was not retried', signal.aborted ? 'ABORTED' : 'CODEX_CLOUD_FAILED') }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          if (response.status === 401 && attempt === 0 && this.options.recoverCredential) {
            let recovered: boolean
            try { recovered = await cancellable(this.options.recoverCredential(credentialCopy(credential), signal), signal) }
            catch { throw fail(signal.aborted ? 'Codex cloud request cancelled or timed out' : 'Codex cloud credential recovery failed', signal.aborted ? 'ABORTED' : 'AUTH_REQUIRED') }
            if (recovered) {
              credential = await this.resolveCredential(signal)
              if (credential.accountId !== accountId) throw fail('Codex account changed during request; start a new call with the active account', 'CODEX_ACCOUNT_CHANGED')
              continue
            }
          }
          throw fail('Codex cloud service returned HTTP ' + response.status, response.status === 401 ? 'AUTH_REQUIRED' : 'CODEX_CLOUD_HTTP_ERROR')
        }
        const reader = response.body?.getReader()
        if (!reader) throw fail('Codex cloud response is empty')
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          const declared = response.headers.get('content-length')
          if (declared !== null && Number(declared) > maxBytes) throw fail('Codex cloud response exceeds byte limit')
          while (true) {
            let part: ReadableStreamReadResult<Uint8Array>
            try { part = await cancellable(reader.read(), signal) }
            catch { throw fail(signal.aborted ? 'Codex cloud request cancelled or timed out' : 'Codex cloud response interrupted; it was not retried', signal.aborted ? 'ABORTED' : 'CODEX_CLOUD_FAILED') }
            if (part.done) break
            size += part.value.byteLength
            if (size > maxBytes) throw fail('Codex cloud response exceeds byte limit')
            chunks.push(part.value)
          }
        } catch (error) {
          void reader.cancel().catch(() => {})
          if (error instanceof LlmError) throw error
          throw fail('Codex cloud response interrupted; it was not retried')
        } finally { reader.releaseLock() }
        let parsed: unknown
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
        catch { throw fail('Codex cloud service returned invalid JSON') }
        const requestId = path.startsWith('images/')
          ? response.headers.get('x-codex-imagegen-request-id') ?? response.headers.get('x-request-id')
          : response.headers.get('x-request-id')
        return { body: parsed, ...(requestId && /^[a-zA-Z0-9_.:-]{1,256}$/.test(requestId) && !requestId.includes(credential.accessToken) ? { requestId } : {}) }
      }
      throw fail('Codex cloud authentication failed', 'AUTH_REQUIRED')
    } finally {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
    }
  }
}
