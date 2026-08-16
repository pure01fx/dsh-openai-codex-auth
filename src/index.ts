/** Native OpenAI Codex OAuth login for DeepSeek Harness. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE_URL = 'https://auth.openai.com'
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`
const BROWSER_REDIRECT_URI = 'http://localhost:1455/auth/callback'
const BROWSER_CALLBACK_HOSTS = ['127.0.0.1', '::1'] as const
const BROWSER_CALLBACK_PORT = 1455
const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000
const BROWSER_LOGIN_TIMEOUT_MS = 10 * 60_000
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5
const MIN_DEVICE_INTERVAL_MS = 1_000
const SLOW_DOWN_INCREMENT_MS = 5_000
const DEFAULT_FILENAME = 'openai-codex-auth.json'
const TOKEN_REF = credentialRef('DSH_OPENAI_CODEX_TOKEN')
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const USAGE_CACHE_MS = 30_000
const MAX_ERROR_BODY_LENGTH = 1_024
const MAX_REQUEST_BODY_LENGTH = 8_192

/** Persisted OAuth credential. */
export interface OpenAICodexCredential {
  access: string
  refresh: string
  expires: number
  accountId: string
}

/** Plugin configuration. */
export interface Config { path?: string; dshHome?: string }

interface Document { version: 1; credential: OpenAICodexCredential }

interface UsageWindow {
  usedPercent: number
  windowSeconds?: number
  resetAt?: number
}

interface UsageSummary {
  planType?: string
  primary?: UsageWindow
  secondary?: UsageWindow
  limitReached?: boolean
  resetCredits?: number
  fetchedAt: number
}

interface WebRuntimeValues {
  lanAddresses: string[]
  trustedHosts: string[]
}

interface LoginSuccess { ok: true }
interface LoginFailure { ok: false; error: string }
type LoginResult = LoginSuccess | LoginFailure

interface DeviceAuthorization {
  deviceAuthId: string
  userCode: string
  intervalSeconds: number
  expiresAt: number
}

interface DeviceTokenCode {
  authorizationCode: string
  codeVerifier: string
}

interface DeviceLoginFlow extends DeviceAuthorization {
  kind: 'device'
  verificationUri: string
  abort: AbortController
  completion: Promise<LoginResult>
}

interface BrowserLoginFlow {
  kind: 'browser'
  url: string
  redirectUri: string
  state: string
  probeToken: string
  probeUrl: string
  expiresAt: number
  abort: AbortController
  servers: Server[]
  resolveCode: (code: string) => void
  rejectCode: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  completion: Promise<LoginResult>
}

type LoginFlow = DeviceLoginFlow | BrowserLoginFlow

interface ParsedDevicePoll {
  status: 'pending' | 'slow_down' | 'complete' | 'failed'
  value?: DeviceTokenCode
  message?: string
}

class DeviceCodeUnavailableError extends Error {
  readonly code = 'device_code_unavailable'
}

class LoginConflictError extends Error {}
class CredentialNotWritableError extends Error {}

function base64Url(value: Buffer): string {
  return value.toString('base64url')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function accountId(access: string): string {
  const parts = access.split('.')
  if (parts.length !== 3) throw new Error('OpenAI returned an invalid access token')
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
    'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown }
  }
  const id = payload['https://api.openai.com/auth']?.chatgpt_account_id
  if (typeof id !== 'string' || id.length === 0) throw new Error('OpenAI token has no ChatGPT account id')
  return id
}

function parseCredential(text: string, filename: string): OpenAICodexCredential {
  const value = JSON.parse(text) as Partial<Document>
  const credential = value.credential
  if (value.version !== 1 || credential === undefined
    || typeof credential.access !== 'string' || typeof credential.refresh !== 'string'
    || typeof credential.expires !== 'number' || typeof credential.accountId !== 'string') {
    throw new Error(`openai-codex-auth: invalid credential document ${filename}`)
  }
  return credential
}

async function readCredential(filename: string): Promise<OpenAICodexCredential | undefined> {
  try {
    return parseCredential(await readFile(filename, 'utf8'), filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function responseText(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY_LENGTH)
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_REQUEST_BODY_LENGTH) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  if (length === 0) throw new Error('Request body is required')
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object')
  return value as Record<string, unknown>
}

function parseManualAuthorizationInput(input: string): { code: string; state?: string } {
  const text = input.trim()
  if (text.length === 0) throw new Error('Paste the authorization code or complete callback URL')
  if (text.length > 6_000) throw new Error('Authorization input is too long')
  const readParams = (params: URLSearchParams): { code: string; state?: string } | undefined => {
    const code = params.get('code')?.trim()
    if (!code) return undefined
    const state = params.get('state')?.trim()
    return { code, ...state ? { state } : {} }
  }
  try {
    const url = new URL(text)
    const parsed = readParams(url.searchParams)
    if (parsed !== undefined) return parsed
  } catch {}
  if (text.includes('code=')) {
    const parsed = readParams(new URLSearchParams(text.replace(/^[?#]/, '')))
    if (parsed !== undefined) return parsed
  }
  return { code: text }
}

async function tokenRequest(body: URLSearchParams, signal?: AbortSignal): Promise<OpenAICodexCredential> {
  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    if (signal?.aborted) throw new Error('OpenAI login cancelled')
    throw error
  }
  if (!response.ok) {
    const text = await responseText(response)
    throw new Error(`OpenAI token request failed (HTTP ${response.status})${text ? `: ${text}` : ''}`)
  }
  const value = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null
  if (value === null || typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string'
    || typeof value.expires_in !== 'number') throw new Error('OpenAI token response is incomplete')
  return {
    access: value.access_token,
    refresh: value.refresh_token,
    expires: Date.now() + value.expires_in * 1000,
    accountId: accountId(value.access_token),
  }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function usageWindow(value: unknown): UsageWindow | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const usedPercent = optionalNumber(row.used_percent ?? row.usedPercent)
  if (usedPercent === undefined) return undefined
  const windowSeconds = optionalNumber(row.limit_window_seconds ?? row.windowDurationSecs)
  const resetAt = optionalNumber(row.reset_at ?? row.resetsAt)
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...windowSeconds === undefined ? {} : { windowSeconds },
    ...resetAt === undefined ? {} : { resetAt },
  }
}

/** Reduce the OpenAI response to the stable fields displayed by the Web card. */
export function normalizeUsage(value: unknown): UsageSummary {
  const root = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const limits = root.rate_limit !== null && typeof root.rate_limit === 'object'
    ? root.rate_limit as Record<string, unknown>
    : root.rateLimits !== null && typeof root.rateLimits === 'object'
      ? root.rateLimits as Record<string, unknown>
      : {}
  const credits = root.rate_limit_reset_credits !== null && typeof root.rate_limit_reset_credits === 'object'
    ? root.rate_limit_reset_credits as Record<string, unknown>
    : undefined
  const planType = typeof root.plan_type === 'string'
    ? root.plan_type
    : typeof root.planType === 'string' ? root.planType : undefined
  const primary = usageWindow(limits.primary_window ?? limits.primary)
  const secondary = usageWindow(limits.secondary_window ?? limits.secondary)
  const limitReached = typeof limits.limit_reached === 'boolean'
    ? limits.limit_reached
    : typeof limits.limitReached === 'boolean' ? limits.limitReached : undefined
  const resetCredits = optionalNumber(credits?.available_count ?? credits?.availableCount)
  return {
    ...planType === undefined ? {} : { planType },
    ...primary === undefined ? {} : { primary },
    ...secondary === undefined ? {} : { secondary },
    ...limitReached === undefined ? {} : { limitReached },
    ...resetCredits === undefined ? {} : { resetCredits },
    fetchedAt: Date.now(),
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string | undefined): URL | undefined {
  if (authority === undefined) return undefined
  try {
    const url = new URL(`http://${authority}`)
    return canonicalAuthority(authority, url) === authority.toLowerCase() ? url : undefined
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedHost(authority: string | undefined, trustedHosts: readonly string[]): boolean {
  const hostUrl = parseAuthority(authority)
  return hostUrl !== undefined
    && (isLoopbackHostname(hostUrl.hostname) || isTrustedAuthority(hostUrl, trustedHosts))
}

function isTrustedBrowserRequest(request: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = header(request, 'host')
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined || !isTrustedHost(host, trustedHosts)) return false
  const fetchSite = header(request, 'sec-fetch-site')
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  const origin = header(request, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function browserCallbackUrl(authority: string | undefined, _fallbackPort: number): string | undefined {
  if (authority === undefined) return undefined
  const url = parseAuthority(authority)
  if (url === undefined || (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) return undefined
  return BROWSER_REDIRECT_URI
}

function callbackHostMatches(authority: string | undefined, redirectUri: string): boolean {
  const requestHost = parseAuthority(authority)?.host
  return requestHost !== undefined && requestHost === new URL(redirectUri).host
}

function isAllowedBrowserProbeOrigin(origin: string | undefined): origin is string {
  if (origin === undefined) return false
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  } catch {
    return false
  }
}

function closeBrowserCallbackServer(server: Server, force = false): Promise<void> {
  return new Promise((resolveClose) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      server.removeListener('close', settle)
      resolveClose()
    }
    server.once('close', settle)
    try {
      server.close(() => { settle() })
      if (force) server.closeAllConnections()
    } catch (error) {
      server.removeListener('close', settle)
      if ((error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        server.closeAllConnections()
      }
      settle()
    }
  })
}

async function closeBrowserCallbackServers(servers: readonly Server[], force = false): Promise<void> {
  await Promise.all(servers.map(server => closeBrowserCallbackServer(server, force)))
}

function listenBrowserCallbackServer(server: Server, host: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    let settled = false
    let cancelled = false
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      server.removeListener('error', onError)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolveListen()
      else rejectListen(error)
    }
    const onError = (error: Error): void => {
      if (cancelled || signal.aborted) {
        settle(new Error('OpenAI login cancelled'))
        return
      }
      const code = (error as NodeJS.ErrnoException).code
      const detail = code === 'EADDRINUSE'
        ? 'Port 1455 is already in use. Close the other Codex login listener and try again.'
        : `Unable to listen on ${host}:1455: ${error.message}`
      const failure = new Error(detail) as Error & NodeJS.ErrnoException
      failure.code = code
      settle(failure)
    }
    const onAbort = (): void => {
      cancelled = true
      if (server.listening) {
        void closeBrowserCallbackServer(server).finally(() => { settle(new Error('OpenAI login cancelled')) })
      }
    }
    if (signal.aborted) {
      settle(new Error('OpenAI login cancelled'))
      return
    }
    server.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    server.listen({ port: BROWSER_CALLBACK_PORT, host, ipv6Only: host === '::1' }, () => {
      if (cancelled || signal.aborted) {
        void closeBrowserCallbackServer(server).finally(() => { settle(new Error('OpenAI login cancelled')) })
      } else {
        settle()
      }
    })
  })
}

async function startDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization> {
  let response: Response
  try {
    response = await fetch(DEVICE_USER_CODE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    if (signal?.aborted) throw new Error('OpenAI login cancelled')
    throw error
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new DeviceCodeUnavailableError('OpenAI device-code login is not enabled for this account or workspace. Use browser login instead.')
    }
    const text = await responseText(response)
    throw new Error(`OpenAI device-code request failed (HTTP ${response.status})${text ? `: ${text}` : ''}`)
  }
  const value = await response.json() as {
    device_auth_id?: unknown
    user_code?: unknown
    interval?: unknown
  } | null
  const rawInterval = value?.interval
  const interval = typeof rawInterval === 'string' && rawInterval.trim() !== ''
    ? Number(rawInterval.trim())
    : rawInterval
  if (value === null || typeof value.device_auth_id !== 'string' || value.device_auth_id.length === 0
    || typeof value.user_code !== 'string' || value.user_code.length === 0
    || typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0) {
    throw new Error('OpenAI returned an invalid device-code response')
  }
  return {
    deviceAuthId: value.device_auth_id,
    userCode: value.user_code,
    intervalSeconds: interval,
    expiresAt: Date.now() + DEVICE_CODE_TIMEOUT_MS,
  }
}

function errorCodeFromText(text: string): string | undefined {
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as { error?: unknown }
    const error = value?.error
    if (typeof error === 'string') return error
    if (error !== null && typeof error === 'object') {
      const code = (error as { code?: unknown }).code
      return typeof code === 'string' ? code : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

async function parseDevicePollResponse(response: Response): Promise<ParsedDevicePoll> {
  if (response.ok) {
    const value = await response.json() as { authorization_code?: unknown; code_verifier?: unknown } | null
    if (value === null || typeof value.authorization_code !== 'string' || value.authorization_code.length === 0
      || typeof value.code_verifier !== 'string' || value.code_verifier.length === 0) {
      return { status: 'failed', message: 'OpenAI returned an invalid device authorization result' }
    }
    return {
      status: 'complete',
      value: { authorizationCode: value.authorization_code, codeVerifier: value.code_verifier },
    }
  }
  const text = await responseText(response)
  const code = errorCodeFromText(text)
  if (code === 'deviceauth_authorization_pending' || code === 'authorization_pending') return { status: 'pending' }
  if (code === 'slow_down') return { status: 'slow_down' }
  if (code === 'access_denied' || code === 'expired_token' || code === 'authorization_declined') {
    return { status: 'failed', message: `OpenAI device authorization failed: ${code}` }
  }
  if (response.status === 403 || response.status === 404) return { status: 'pending' }
  return {
    status: 'failed',
    message: `OpenAI device authorization failed (HTTP ${response.status})${text ? `: ${text}` : ''}`,
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      rejectSleep(new Error('OpenAI login cancelled'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectSleep(new Error('OpenAI login cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveSleep()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function pollDeviceAuthorization(device: DeviceAuthorization, signal?: AbortSignal): Promise<DeviceTokenCode> {
  let intervalMs = Math.max(MIN_DEVICE_INTERVAL_MS,
    Math.floor((device.intervalSeconds ?? DEFAULT_DEVICE_INTERVAL_SECONDS) * 1_000))
  while (Date.now() < device.expiresAt) {
    if (signal?.aborted) throw new Error('OpenAI login cancelled')
    let response: Response
    try {
      response = await fetch(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      if (signal?.aborted) throw new Error('OpenAI login cancelled')
      throw error
    }
    const result = await parseDevicePollResponse(response)
    if (result.status === 'complete') return result.value!
    if (result.status === 'failed') throw new Error(result.message ?? 'OpenAI device authorization failed')
    if (result.status === 'slow_down') intervalMs += SLOW_DOWN_INCREMENT_MS
    const remaining = device.expiresAt - Date.now()
    if (remaining <= 0) break
    await abortableSleep(Math.min(intervalMs, remaining), signal)
  }
  throw new Error('OpenAI device-code login timed out')
}

export const internals = {
  parseAuthority,
  isLoopbackHostname,
  isTrustedHost,
  isTrustedBrowserRequest,
  browserCallbackUrl,
  callbackHostMatches,
  startDeviceAuthorization,
  parseDevicePollResponse,
  pollDeviceAuthorization,
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    openaiCodexAuth: OpenAICodexAuth
    webServer: WebServer
    webRuntime: WebRuntimeValues
  }
}

/** DSH service providing device-code/browser login, logout, and automatically refreshed bearer tokens. */
export class OpenAICodexAuth extends Service {
  static Config: z<Config> = z.object({ path: z.string(), dshHome: z.string() })
  static inject = ['credentials', 'webServer', 'webRuntime']
  private readonly filename: string
  private readonly csrf = base64Url(randomBytes(24))
  private usageCache: UsageSummary | undefined
  private usageError: string | undefined
  private loginFlow: LoginFlow | undefined
  private startingDevice: { abort: AbortController; promise: Promise<DeviceLoginFlow> } | undefined
  private startingBrowser: { abort: AbortController; servers: Server[]; promise: Promise<BrowserLoginFlow> } | undefined
  private lastLoginError: string | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'openaiCodexAuth')
    this.filename = resolve(config.path ?? join(resolveDshHome(config.dshHome), DEFAULT_FILENAME))
    ctx.effect(async () => {
      try {
        const token = await this.bearerToken()
        if (token !== undefined) await this.storeCredentialToken(token)
      } catch (error) {
        this.lastLoginError = messageOf(error)
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
      return () => {}
    }, 'openai-codex-auth: bootstrap credential')
    ctx.effect(() => {
      const timer = setInterval(() => {
        void this.bearerToken()
          .then(token => token === undefined ? undefined : this.storeCredentialToken(token))
          .catch((error: unknown) => { this.usageError = messageOf(error) })
      }, 60_000)
      return () => { clearInterval(timer) }
    }, 'openai-codex-auth: refresh timer')
    ctx.effect(() => {
      const disposers: Array<() => void> = []
      try {
        const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void => {
          disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }))
        }
        register('/openai-codex/status', (req, res) => this.handleStatus(req, res))
        register('/openai-codex/device/start', (req, res) => this.handleDeviceStart(req, res))
        register('/openai-codex/browser/start', (req, res) => this.handleBrowserStart(req, res))
        register('/openai-codex/browser/prepare', (req, res) => this.handleBrowserPrepare(req, res))
        register('/openai-codex/browser/complete', (req, res) => this.handleBrowserComplete(req, res))
        register('/openai-codex/cancel', (req, res) => this.handleCancel(req, res))
        register('/openai-codex/logout', (req, res) => this.handleLogout(req, res))
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose()
        throw error
      }
      return async () => {
        const startingDevice = this.startingDevice
        startingDevice?.abort.abort()
        if (startingDevice !== undefined) await startingDevice.promise.catch(() => undefined)
        const startingBrowser = this.startingBrowser
        startingBrowser?.abort.abort()
        if (startingBrowser !== undefined) {
          await startingBrowser.promise.catch(() => undefined)
          await closeBrowserCallbackServers(startingBrowser.servers, true)
        }
        const flow = this.loginFlow
        flow?.abort.abort()
        if (flow !== undefined) {
          await flow.completion
          if (flow.kind === 'browser') await closeBrowserCallbackServers(flow.servers, true)
        }
        for (const dispose of disposers.reverse()) dispose()
      }
    }, 'openai-codex-auth: Web routes')
  }

  private async assertCredentialWritable(): Promise<void> {
    const info = await this.ctx.credentials.describe(TOKEN_REF)
    if (!info.writable) {
      throw new CredentialNotWritableError(`DSH_OPENAI_CODEX_TOKEN is supplied by read-only source ${info.source ?? 'unknown'}; remove that override before logging in`)
    }
  }

  private async storeCredentialToken(token: string): Promise<void> {
    await this.assertCredentialWritable()
    await this.ctx.credentials.set(TOKEN_REF, token)
  }

  /** Return a valid bearer token, refreshing and persisting it when near expiry. */
  async bearerToken(signal?: AbortSignal): Promise<string | undefined> {
    return withFileLock(this.filename, async () => {
      const current = await readCredential(this.filename)
      if (current === undefined) return undefined
      if (current.expires > Date.now() + 60_000) return current.access
      await this.assertCredentialWritable()
      const next = await tokenRequest(new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: current.refresh, client_id: CLIENT_ID,
      }), signal)
      if (signal?.aborted) throw new Error('OpenAI login cancelled')
      await this.write(next)
      if (signal?.aborted) throw new Error('OpenAI login cancelled')
      await this.ctx.credentials.set(TOKEN_REF, next.access)
      return next.access
    })
  }

  private async finishCredential(credential: OpenAICodexCredential, signal: AbortSignal): Promise<void> {
    await this.assertCredentialWritable()
    if (signal.aborted) throw new Error('OpenAI login cancelled')
    await withFileLock(this.filename, async () => {
      if (signal.aborted) throw new Error('OpenAI login cancelled')
      await this.write(credential)
    })
    if (signal.aborted) throw new Error('OpenAI login cancelled')
    await this.ctx.credentials.set(TOKEN_REF, credential.access)
    this.usageCache = undefined
    this.usageError = undefined
    this.lastLoginError = undefined
  }

  private async finishAuthorizationCode(code: string, verifier: string, redirectUri: string, signal: AbortSignal): Promise<void> {
    const credential = await tokenRequest(new URLSearchParams({
      grant_type: 'authorization_code', client_id: CLIENT_ID, code,
      code_verifier: verifier, redirect_uri: redirectUri,
    }), signal)
    await this.finishCredential(credential, signal)
  }

  private settleFlow(flow: LoginFlow, work: Promise<void>, cleanup?: () => void): Promise<LoginResult> {
    return work
      .then((): LoginResult => ({ ok: true }))
      .catch((error: unknown): LoginResult => {
        const message = messageOf(error)
        this.lastLoginError = message
        return { ok: false, error: message }
      })
      .finally(() => {
        cleanup?.()
        if (this.loginFlow === flow) this.loginFlow = undefined
      })
  }

  private beginDeviceLogin(): Promise<DeviceLoginFlow> {
    if (this.loginFlow?.kind === 'device') return Promise.resolve(this.loginFlow)
    if (this.startingDevice !== undefined) return this.startingDevice.promise
    if (this.startingBrowser !== undefined || this.loginFlow !== undefined) {
      return Promise.reject(new LoginConflictError('A browser login is already pending. Cancel it before starting device-code login.'))
    }
    this.lastLoginError = undefined
    const abort = new AbortController()
    const promise = this.createDeviceLogin(abort)
    const starting = { abort, promise }
    this.startingDevice = starting
    void promise.then(
      () => { if (this.startingDevice === starting) this.startingDevice = undefined },
      (error: unknown) => {
        this.lastLoginError = messageOf(error)
        if (this.startingDevice === starting) this.startingDevice = undefined
      },
    )
    return promise
  }

  private async createDeviceLogin(abort: AbortController): Promise<DeviceLoginFlow> {
    await this.assertCredentialWritable()
    const device = await startDeviceAuthorization(abort.signal)
    if (abort.signal.aborted) throw new Error('OpenAI login cancelled')
    let flow!: DeviceLoginFlow
    const work = pollDeviceAuthorization(device, abort.signal)
      .then(code => this.finishAuthorizationCode(code.authorizationCode, code.codeVerifier, DEVICE_REDIRECT_URI, abort.signal))
    flow = {
      kind: 'device',
      ...device,
      verificationUri: DEVICE_VERIFICATION_URI,
      abort,
      completion: undefined as unknown as Promise<LoginResult>,
    }
    flow.completion = this.settleFlow(flow, work)
    this.loginFlow = flow
    return flow
  }

  private beginBrowserLogin(redirectUri: string): Promise<BrowserLoginFlow> {
    if (this.loginFlow?.kind === 'browser') {
      if (this.loginFlow.redirectUri !== redirectUri) {
        return Promise.reject(new LoginConflictError('A browser login is already pending with another callback. Cancel it before starting a new login.'))
      }
      return Promise.resolve(this.loginFlow)
    }
    if (this.startingBrowser !== undefined) return this.startingBrowser.promise
    if (this.startingDevice !== undefined || this.loginFlow !== undefined) {
      return Promise.reject(new LoginConflictError('A device-code login is already pending. Cancel it before starting browser login.'))
    }
    this.lastLoginError = undefined
    const abort = new AbortController()
    const probeToken = base64Url(randomBytes(24))
    const probeUrl = `http://127.0.0.1:${BROWSER_CALLBACK_PORT}/openai-codex/probe?token=${encodeURIComponent(probeToken)}`
    let servers!: Server[]
    const listener = (req: IncomingMessage, res: ServerResponse): void => {
      try {
        const callback = new URL(req.url ?? '/', BROWSER_REDIRECT_URI)
        if (callback.pathname === '/openai-codex/probe') {
          const origin = header(req, 'origin')
          if (callback.searchParams.get('token') !== probeToken || !isAllowedBrowserProbeOrigin(origin)) {
            this.sendJson(res, 403, { ok: false, error: 'Invalid browser callback probe.' })
            return
          }
          const corsHeaders = {
            'access-control-allow-origin': origin,
            'access-control-allow-private-network': 'true',
            vary: 'Origin',
          }
          if (req.method === 'OPTIONS') {
            res.writeHead(204, { ...corsHeaders, 'access-control-allow-methods': 'GET, OPTIONS', 'cache-control': 'no-store' }).end()
            return
          }
          if (req.method !== 'GET') {
            this.sendJson(res, 405, { ok: false, error: 'GET only' }, { ...corsHeaders, allow: 'GET, OPTIONS' })
            return
          }
          this.sendJson(res, 200, { ok: true }, corsHeaders)
          return
        }
        if (callback.pathname !== '/auth/callback') {
          this.sendText(res, 404, 'Not found')
          return
        }
        void this.handleCallback(req, res).finally(() => {
          const active = this.loginFlow
          if (active?.kind !== 'browser' || active.servers !== servers) {
            void closeBrowserCallbackServers(servers)
          }
        })
      } catch (error) {
        this.sendText(res, 400, `Invalid OpenAI OAuth callback: ${messageOf(error)}`)
      }
    }
    servers = BROWSER_CALLBACK_HOSTS.map(() => createServer(listener))
    const promise = this.createBrowserLogin(redirectUri, probeToken, probeUrl, abort, servers)
    const starting = { abort, servers, promise }
    this.startingBrowser = starting
    void promise.then(
      () => { if (this.startingBrowser === starting) this.startingBrowser = undefined },
      (error: unknown) => {
        void closeBrowserCallbackServers(servers, true)
        this.lastLoginError = messageOf(error)
        if (this.startingBrowser === starting) this.startingBrowser = undefined
      },
    )
    return promise
  }

  private async createBrowserLogin(redirectUri: string, probeToken: string, probeUrl: string, abort: AbortController, servers: Server[]): Promise<BrowserLoginFlow> {
    await listenBrowserCallbackServer(servers[0]!, BROWSER_CALLBACK_HOSTS[0], abort.signal)
    try {
      await listenBrowserCallbackServer(servers[1]!, BROWSER_CALLBACK_HOSTS[1], abort.signal)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE' || code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT' || code === 'EPROTONOSUPPORT') {
        servers.splice(1, 1)
      } else {
        throw error
      }
    }
    const verifier = base64Url(randomBytes(32))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    const state = randomBytes(16).toString('hex')
    const url = new URL(AUTHORIZE_URL)
    for (const [key, value] of Object.entries({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri,
      scope: 'openid profile email offline_access', code_challenge: challenge,
      code_challenge_method: 'S256', state, id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true', originator: 'deepseek-harness',
    })) url.searchParams.set(key, value)
    let resolveCode!: (code: string) => void
    let rejectCode!: (error: Error) => void
    const code = new Promise<string>((resolvePromise, rejectPromise) => {
      resolveCode = resolvePromise
      rejectCode = rejectPromise
    })
    const onAbort = (): void => { rejectCode(new Error('OpenAI login cancelled')) }
    abort.signal.addEventListener('abort', onAbort, { once: true })
    const expiresAt = Date.now() + BROWSER_LOGIN_TIMEOUT_MS
    const timeout = setTimeout(() => { abort.abort() }, BROWSER_LOGIN_TIMEOUT_MS)
    let flow!: BrowserLoginFlow
    flow = {
      kind: 'browser',
      url: url.toString(),
      redirectUri,
      state,
      probeToken,
      probeUrl,
      expiresAt,
      abort,
      servers,
      resolveCode,
      rejectCode,
      timeout,
      completion: undefined as unknown as Promise<LoginResult>,
    }
    const work = code.then(authorizationCode => this.finishAuthorizationCode(authorizationCode, verifier, redirectUri, abort.signal))
    flow.completion = this.settleFlow(flow, work, () => {
      clearTimeout(timeout)
      abort.signal.removeEventListener('abort', onAbort)
      void closeBrowserCallbackServers(servers)
    })
    this.loginFlow = flow
    return flow
  }

  private async cancelLogin(clearError: boolean): Promise<void> {
    const startingDevice = this.startingDevice
    if (startingDevice !== undefined) {
      startingDevice.abort.abort()
      await startingDevice.promise.catch(() => undefined)
    }
    const startingBrowser = this.startingBrowser
    if (startingBrowser !== undefined) {
      startingBrowser.abort.abort()
      await startingBrowser.promise.catch(() => undefined)
      await closeBrowserCallbackServers(startingBrowser.servers)
    }
    const flow = this.loginFlow
    if (flow !== undefined) {
      flow.abort.abort()
      await flow.completion
      if (flow.kind === 'browser') await closeBrowserCallbackServers(flow.servers)
    }
    if (clearError) this.lastLoginError = undefined
  }

  private async logout(): Promise<void> {
    await this.cancelLogin(true)
    await withFileLock(this.filename, async () => {
      try { await unlink(this.filename) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
    let unsetError: unknown
    try {
      await this.ctx.credentials.unset(TOKEN_REF)
    } catch (error) {
      unsetError = error
    }
    this.usageCache = undefined
    this.usageError = undefined
    this.lastLoginError = undefined
    if (unsetError !== undefined) {
      throw new Error(`Local OpenAI credential was removed, but DSH_OPENAI_CODEX_TOKEN could not be unset: ${messageOf(unsetError)}`)
    }
  }

  private async status(refresh: boolean, callbackUrl: string | undefined): Promise<Record<string, unknown>> {
    let credential: OpenAICodexCredential | undefined
    let credentialError: string | undefined
    try {
      credential = await readCredential(this.filename)
    } catch (error) {
      credentialError = messageOf(error)
    }
    if (credential !== undefined) {
      try {
        await this.bearerToken()
        credential = await readCredential(this.filename) ?? credential
      } catch (error) {
        this.usageError = messageOf(error)
      }
      if (refresh || this.usageCache === undefined || Date.now() - this.usageCache.fetchedAt > USAGE_CACHE_MS) {
        try {
          this.usageCache = await this.fetchUsage(credential)
          this.usageError = undefined
        } catch (error) {
          this.usageError = messageOf(error)
        }
      }
    }
    const flow = this.loginFlow
    const startingMethod = this.startingDevice !== undefined
      ? 'device'
      : this.startingBrowser !== undefined ? 'browser' : undefined
    const device = flow?.kind === 'device'
      ? { userCode: flow.userCode, verificationUri: flow.verificationUri, expiresAt: flow.expiresAt }
      : undefined
    const browser = flow?.kind === 'browser'
      ? { authorizationUrl: flow.url, probeUrl: flow.probeUrl, expiresAt: flow.expiresAt }
      : undefined
    return {
      loggedIn: credential !== undefined,
      loginPending: startingMethod !== undefined || flow !== undefined,
      ...startingMethod !== undefined ? { loginMethod: startingMethod } : flow === undefined ? {} : { loginMethod: flow.kind },
      ...this.lastLoginError === undefined ? {} : { loginError: this.lastLoginError },
      ...credentialError === undefined ? {} : { credentialError },
      ...callbackUrl === undefined ? {} : { browserCallbackUrl: callbackUrl },
      ...device === undefined ? {} : { device },
      ...browser === undefined ? {} : { browser },
      ...credential === undefined ? {} : {
        accountId: credential.accountId,
        expiresAt: credential.expires,
        ...this.usageCache === undefined ? {} : { usage: this.usageCache },
        ...this.usageError === undefined ? {} : { usageError: this.usageError },
      },
      csrf: this.csrf,
    }
  }

  private async fetchUsage(credential: OpenAICodexCredential): Promise<UsageSummary> {
    const access = await this.bearerToken()
    if (access === undefined) throw new Error('OpenAI login is missing')
    const response = await fetch(USAGE_URL, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${access}`,
        'chatgpt-account-id': credential.accountId,
        'user-agent': 'dsh-openai-codex-auth/0.4.0',
      },
    })
    if (!response.ok) throw new Error(`Codex usage request failed (HTTP ${response.status})`)
    return normalizeUsage(await response.json())
  }

  private write(credential: OpenAICodexCredential): Promise<void> {
    return writeFileAtomic(this.filename, `${JSON.stringify({ version: 1, credential }, null, 2)}\n`, {
      mode: 0o600, dirMode: 0o700,
    })
  }

  private sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
    res.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    }).end(JSON.stringify(value))
  }

  private sendText(res: ServerResponse, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
    res.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    }).end(text)
  }

  private trustedManagementRequest(req: IncomingMessage, res: ServerResponse): boolean {
    if (isTrustedBrowserRequest(req, this.ctx.webRuntime.trustedHosts)) return true
    this.sendJson(res, 403, { error: 'Untrusted browser request.' })
    return false
  }

  private requireCsrf(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.headers['x-dsh-csrf'] === this.csrf) return true
    this.sendJson(res, 403, { error: 'Invalid CSRF token.' })
    return false
  }

  private async handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.trustedManagementRequest(req, res)) return
    if (req.method !== 'GET') {
      this.sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' })
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const callback = browserCallbackUrl(header(req, 'host'), this.ctx.webServer.port)
      this.sendJson(res, 200, await this.status(url.searchParams.get('refresh') === '1', callback))
    } catch (error) {
      this.sendJson(res, 500, { error: messageOf(error) })
    }
  }

  private async handleDeviceStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.trustedManagementRequest(req, res)) return
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
      return
    }
    if (!this.requireCsrf(req, res)) return
    try {
      const flow = await this.beginDeviceLogin()
      this.sendJson(res, 200, {
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        expiresAt: flow.expiresAt,
      })
    } catch (error) {
      const unavailable = error instanceof DeviceCodeUnavailableError
      const conflict = error instanceof LoginConflictError || error instanceof CredentialNotWritableError
      this.sendJson(res, unavailable || conflict ? 409 : 502, {
        error: messageOf(error),
        ...unavailable ? { code: error.code } : {},
      })
    }
  }

  private async handleBrowserStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.trustedManagementRequest(req, res)) return
    if (req.method !== 'GET') {
      this.sendJson(res, 405, { error: 'GET only' }, { allow: 'GET' })
      return
    }
    try {
      const redirectUri = browserCallbackUrl(header(req, 'host'), this.ctx.webServer.port)
      if (redirectUri === undefined) {
        this.sendJson(res, 400, { error: 'Browser OAuth requires an HTTP 127.0.0.1 or localhost entry URL. Use device-code login instead.' })
        return
      }
      await this.assertCredentialWritable()
      const flow = await this.beginBrowserLogin(redirectUri)
      res.writeHead(302, { location: flow.url, 'cache-control': 'no-store' }).end()
    } catch (error) {
      this.sendJson(res, 409, { error: messageOf(error) })
    }
  }

  private async handleBrowserPrepare(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.trustedManagementRequest(req, res)) return
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
      return
    }
    if (!this.requireCsrf(req, res)) return
    try {
      const redirectUri = browserCallbackUrl(header(req, 'host'), this.ctx.webServer.port)
      if (redirectUri === undefined) {
        this.sendJson(res, 400, { error: 'Browser OAuth requires an HTTP 127.0.0.1 or localhost entry URL. Use device-code login instead.' })
        return
      }
      await this.assertCredentialWritable()
      const flow = await this.beginBrowserLogin(redirectUri)
      this.sendJson(res, 200, {
        authorizationUrl: flow.url,
        probeUrl: flow.probeUrl,
        expiresAt: flow.expiresAt,
      })
    } catch (error) {
      const conflict = error instanceof LoginConflictError || error instanceof CredentialNotWritableError
      this.sendJson(res, conflict ? 409 : 502, { error: messageOf(error) })
    }
  }

  private async handleBrowserComplete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.trustedManagementRequest(req, res)) return
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
      return
    }
    if (!this.requireCsrf(req, res)) return
    try {
      const flow = this.loginFlow
      if (flow?.kind !== 'browser') {
        this.sendJson(res, 409, { error: 'No OpenAI browser login is pending.' })
        return
      }
      const body = await readJsonBody(req)
      if (typeof body.input !== 'string') {
        this.sendJson(res, 400, { error: 'The input field must contain an authorization code or callback URL.' })
        return
      }
      const parsed = parseManualAuthorizationInput(body.input)
      if (parsed.state !== undefined && parsed.state !== flow.state) {
        this.sendJson(res, 400, { error: 'The pasted callback state does not match this login.' })
        return
      }
      flow.resolveCode(parsed.code)
      const result = await flow.completion
      if (result.ok) this.sendJson(res, 200, { ok: true })
      else this.sendJson(res, 502, { error: result.error })
    } catch (error) {
      this.sendJson(res, 400, { error: messageOf(error) })
    }
  }

  private async handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      this.sendText(res, 405, 'GET only', { allow: 'GET' })
      return
    }
    try {
      const flow = this.loginFlow
      if (flow?.kind !== 'browser') {
        this.sendText(res, 400, 'No OpenAI browser login is pending.')
        return
      }
      if (!callbackHostMatches(header(req, 'host'), flow.redirectUri)) {
        this.sendText(res, 400, 'Invalid OpenAI OAuth callback host.')
        return
      }
      const url = new URL(req.url ?? '', flow.redirectUri)
      if (url.searchParams.get('state') !== flow.state) {
        this.sendText(res, 400, 'Invalid OpenAI OAuth callback state.')
        return
      }
      const oauthError = url.searchParams.get('error')
      if (oauthError !== null) {
        const description = (url.searchParams.get('error_description') ?? oauthError).slice(0, 500)
        flow.rejectCode(new Error(`OpenAI login failed: ${description}`))
        const result = await flow.completion
        this.sendText(res, 400, result.ok ? 'OpenAI login cancelled.' : result.error)
        return
      }
      const code = url.searchParams.get('code')
      if (code === null || code.length === 0) {
        flow.rejectCode(new Error('Missing authorization code'))
        const result = await flow.completion
        this.sendText(res, 400, result.ok ? 'Missing authorization code.' : result.error)
        return
      }
      flow.resolveCode(code)
      const result = await flow.completion
      if (result.ok) {
        this.sendText(res, 200, 'OpenAI login complete. You may close this window.')
      } else {
        this.sendText(res, 502, `OpenAI login failed: ${result.error}`)
      }
    } catch (error) {
      this.sendText(res, 400, `Invalid OpenAI OAuth callback: ${messageOf(error)}`)
    }
  }

  private async handleCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.trustedManagementRequest(req, res)) return
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
      return
    }
    if (!this.requireCsrf(req, res)) return
    try {
      await this.cancelLogin(true)
      this.sendJson(res, 200, { ok: true })
    } catch (error) {
      this.sendJson(res, 500, { error: messageOf(error) })
    }
  }

  private async handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.trustedManagementRequest(req, res)) return
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'POST only' }, { allow: 'POST' })
      return
    }
    if (!this.requireCsrf(req, res)) return
    try {
      await this.logout()
      this.sendJson(res, 200, { ok: true })
    } catch (error) {
      this.sendJson(res, 500, { error: messageOf(error) })
    }
  }
}

export default OpenAICodexAuth
