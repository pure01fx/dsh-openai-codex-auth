import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import OpenAICodexAuth, { internals, type OpenAICodexCredential } from '../src/index.ts'

type Handler = (req: any, res: any) => void | Promise<void>

class FakeWebServer {
  port = 3080
  host = '127.0.0.1' as const
  routes = new Map<string, Handler>()

  register(route: { path: string; handler: Handler }): () => void {
    if (this.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

class FakeCredentials {
  value: string | undefined
  writable = true
  source: string | undefined

  async resolve(): Promise<{ value: string; source: string } | undefined> {
    return this.value === undefined
      ? undefined
      : { value: this.value, source: this.source ?? 'file' }
  }

  async describe(): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    return {
      configured: this.value !== undefined,
      ...this.source === undefined ? {} : { source: this.source },
      writable: this.writable,
    }
  }

  async set(_ref: unknown, value: string): Promise<void> {
    if (!this.writable) throw new Error('read-only credential source')
    this.value = value
  }

  async unset(): Promise<void> {
    if (!this.writable) throw new Error('read-only credential source')
    this.value = undefined
  }
}

class FakeResponse {
  statusCode = 0
  headers: Record<string, string> = {}
  body = ''
  ended = false

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
    return this
  }

  end(body = ''): this {
    this.body = String(body)
    this.ended = true
    return this
  }
}

function request(method: string, url: string, headers: Record<string, string> = {}): any {
  return { method, url, headers }
}

function jsonRequest(method: string, url: string, headers: Record<string, string>, body: unknown): any {
  return {
    method,
    url,
    headers: { ...headers, 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
}

async function call(web: FakeWebServer, path: string, req: any): Promise<FakeResponse> {
  const handler = web.routes.get(path)
  if (handler === undefined) throw new Error(`missing route ${path}`)
  const response = new FakeResponse()
  await handler(req, response)
  return response
}

function localBrowserCallback(path: string, host = 'localhost:1455', address = '127.0.0.1', headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest({
      host: address,
      port: 1455,
      path,
      method: 'GET',
      agent: false,
      headers: { host, ...headers },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      res.on('end', () => {
        resolveRequest({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
      })
    })
    req.once('error', rejectRequest)
    req.end()
  })
}

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function accessToken(accountId = 'acct_test', expiresAt?: number): string {
  return jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    ...expiresAt === undefined ? {} : { exp: Math.floor(expiresAt / 1_000) },
  })
}

function idToken(accountId = 'acct_test'): string {
  return jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })
}

async function writeCredential(home: string, credential: OpenAICodexCredential): Promise<void> {
  await writeFile(join(home, 'openai-codex-auth.json'), JSON.stringify({ version: 1, credential }))
}

async function readCredential(home: string): Promise<OpenAICodexCredential> {
  return JSON.parse(await readFile(join(home, 'openai-codex-auth.json'), 'utf8')).credential
}

async function createHarness(): Promise<{
  root: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  web: FakeWebServer
  credentials: FakeCredentials
  home: string
}> {
  const root = new Context()
  const web = new FakeWebServer()
  const credentials = new FakeCredentials()
  root.provide('webServer', web)
  root.provide('webRuntime', { lanAddresses: [], trustedHosts: [] })
  root.provide('credentials', credentials)
  const home = await mkdtemp(join(tmpdir(), 'openai-codex-auth-'))
  const fiber = await root.plugin(OpenAICodexAuth, { dshHome: home })
  await new Promise<void>(resolveBootstrap => { setImmediate(resolveBootstrap) })
  return { root, fiber, web, credentials, home }
}

async function disposeHarness(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  await harness.fiber.dispose()
  await rm(harness.home, { recursive: true, force: true })
}

describe('request trust and callback URL', () => {
  it('uses the exact callback registered for the public Codex CLI client', () => {
    expect(internals.browserCallbackUrl('127.0.0.1:3080', 9999))
      .toBe('http://localhost:1455/auth/callback')
    expect(internals.browserCallbackUrl('localhost:8080', 9999))
      .toBe('http://localhost:1455/auth/callback')
    expect(internals.browserCallbackUrl('localhost', 4321))
      .toBe('http://localhost:1455/auth/callback')
    expect(internals.browserCallbackUrl('dsh.example.com', 3080)).toBeUndefined()
  })

  it('matches DSH loopback and trusted-host semantics', () => {
    expect(internals.isTrustedHost('127.9.8.7:3080', [])).toBe(true)
    expect(internals.isTrustedHost('[::1]:3080', [])).toBe(true)
    expect(internals.isTrustedHost('dsh.example.com:8443', ['dsh.example.com'])).toBe(true)
    expect(internals.isTrustedHost('dsh.example.com:8443', ['dsh.example.com:443'])).toBe(false)
    expect(internals.isTrustedHost('evil.example.com:3080', [])).toBe(false)
    expect(internals.isTrustedHost('127.0.0.1/path', [])).toBe(false)
    expect(internals.isTrustedHost('user@127.0.0.1', [])).toBe(false)
    expect(internals.isTrustedHost('127.0.0.1:03080', [])).toBe(false)
    expect(internals.isTrustedHost('127.0.0.1:99999', [])).toBe(false)
  })

  it('rejects cross-site and mismatched Origin management requests', () => {
    expect(internals.isTrustedBrowserRequest(request('GET', '/', { host: '127.0.0.1:3080' }), [])).toBe(true)
    expect(internals.isTrustedBrowserRequest(request('GET', '/', {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
    }), [])).toBe(true)
    expect(internals.isTrustedBrowserRequest(request('GET', '/', {
      host: '127.0.0.1:3080',
      origin: 'http://localhost:3080',
    }), [])).toBe(false)
    expect(internals.isTrustedBrowserRequest(request('GET', '/', {
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'cross-site',
    }), [])).toBe(false)
    expect(internals.isTrustedBrowserRequest(request('GET', '/', {
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-site',
    }), [])).toBe(false)
    expect(internals.isTrustedBrowserRequest(request('GET', '/', {
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
    }), [])).toBe(true)
  })
})

describe('device-code response handling', () => {
  it('classifies pending, slow-down, denial, and success responses', async () => {
    await expect(internals.parseDevicePollResponse(new Response('', { status: 404 })))
      .resolves.toEqual({ status: 'pending' })
    await expect(internals.parseDevicePollResponse(new Response(JSON.stringify({ error: { code: 'slow_down' } }), { status: 403 })))
      .resolves.toEqual({ status: 'slow_down' })
    await expect(internals.parseDevicePollResponse(new Response(JSON.stringify({ error: { code: 'access_denied' } }), { status: 403 })))
      .resolves.toEqual({ status: 'failed', message: 'OpenAI device authorization failed: access_denied' })
    await expect(internals.parseDevicePollResponse(new Response(JSON.stringify({
      authorization_code: 'code', code_verifier: 'verifier',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
      .resolves.toEqual({
        status: 'complete',
        value: { authorizationCode: 'code', codeVerifier: 'verifier' },
      })
  })
})

describe('OAuth token parsing', () => {
  it('uses initial ID-token identity instead of access-token identity', () => {
    const credential = internals.parseTokenResponse({
      access_token: accessToken('acct_access'),
      refresh_token: 'refresh-1',
      expires_in: 3600,
      id_token: idToken('acct_id'),
    })
    expect(credential).toMatchObject({
      access: accessToken('acct_access'),
      refresh: 'refresh-1',
      accountId: 'acct_id',
    })
  })

  it('rotates returned refresh and identity values but preserves omitted ones', () => {
    const previous: OpenAICodexCredential = {
      access: accessToken('acct_old'),
      refresh: 'refresh-old',
      expires: Date.now() - 1,
      accountId: 'acct_old',
    }
    expect(internals.parseTokenResponse({
      access_token: accessToken('acct_new'),
      refresh_token: 'refresh-new',
      expires_in: 3600,
      id_token: idToken('acct_new'),
    }, previous)).toMatchObject({ refresh: 'refresh-new', accountId: 'acct_new' })
    expect(internals.parseTokenResponse({
      access_token: accessToken('acct_access-only'),
      expires_in: 3600,
    }, previous)).toMatchObject({ refresh: 'refresh-old', accountId: 'acct_old' })
  })

  it('uses the access-token JWT expiry when expires_in is omitted', () => {
    const expiresAt = Math.floor((Date.now() + 3_600_000) / 1_000) * 1_000
    const credential = internals.parseTokenResponse({
      access_token: accessToken('acct_access', expiresAt),
      refresh_token: 'refresh-1',
      id_token: idToken('acct_id'),
    })
    expect(credential.expires).toBe(expiresAt)
  })
})

describe('OpenAICodexAuth routes', () => {
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    if (harness !== undefined) await disposeHarness(harness)
    harness = undefined
  })

  it('registers seven same-origin routes, exposes browser availability, and disposes all routes', async () => {
    harness = await createHarness()
    expect([...harness.web.routes.keys()].sort()).toEqual([
      '/openai-codex/browser/complete',
      '/openai-codex/browser/prepare',
      '/openai-codex/browser/start',
      '/openai-codex/cancel',
      '/openai-codex/device/start',
      '/openai-codex/logout',
      '/openai-codex/status',
    ])
    const status = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: 'localhost:8080',
    }))
    expect(status.statusCode).toBe(200)
    expect(JSON.parse(status.body)).toMatchObject({
      loggedIn: false,
      loginPending: false,
      browserCallbackUrl: 'http://localhost:1455/auth/callback',
    })
    await harness.fiber.dispose()
    expect(harness.web.routes.size).toBe(0)
    await rm(harness.home, { recursive: true, force: true })
    harness = undefined
  })

  it('serializes concurrent JSON refreshes and persists rotated tokens and identity', async () => {
    harness = await createHarness()
    const old: OpenAICodexCredential = {
      access: accessToken('acct_old'),
      refresh: 'refresh-old',
      expires: Date.now() + 30_000,
      accountId: 'acct_old',
    }
    await writeCredential(harness.home, old)
    harness.credentials.value = old.access
    const nextAccess = accessToken('acct_access-new')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: nextAccess,
      refresh_token: 'refresh-new',
      expires_in: 3600,
      id_token: idToken('acct_new'),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(Promise.all([
      harness.root.openaiCodexAuth.bearerToken(),
      harness.root.openaiCodexAuth.bearerToken(),
    ])).resolves.toEqual([nextAccess, nextAccess])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: 'POST', headers: { 'content-type': 'application/json' },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      client_id: expect.any(String),
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
    })
    expect(await readCredential(harness.home)).toMatchObject({
      access: nextAccess,
      refresh: 'refresh-new',
      accountId: 'acct_new',
    })
    expect(harness.credentials.value).toBe(nextAccess)
  })

  it('preserves disk and published credentials on a terminal refresh error', async () => {
    harness = await createHarness()
    const old: OpenAICodexCredential = {
      access: accessToken('acct_old'),
      refresh: 'refresh-old',
      expires: Date.now() - 1,
      accountId: 'acct_old',
    }
    await writeCredential(harness.home, old)
    harness.credentials.value = old.access
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      error: { code: 'refresh_token_reused' },
    }), { status: 400, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(harness.root.openaiCodexAuth.bearerToken()).rejects.toMatchObject({
      status: 400,
      oauthCode: 'refresh_token_reused',
    })
    expect(await readCredential(harness.home)).toEqual(old)
    expect(harness.credentials.value).toBe(old.access)
  })

  it('uses an unexpired access token after transient preemptive failure but not after expiry', async () => {
    harness = await createHarness()
    const old: OpenAICodexCredential = {
      access: accessToken('acct_old'),
      refresh: 'refresh-old',
      expires: Date.now() + 30_000,
      accountId: 'acct_old',
    }
    await writeCredential(harness.home, old)
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      error: 'temporary_failure',
    }), { status: 500, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(harness.root.openaiCodexAuth.bearerToken()).resolves.toBe(old.access)
    const callsAfterFallback = fetchMock.mock.calls.length
    await writeCredential(harness.home, { ...old, expires: Date.now() - 1 })
    await expect(harness.root.openaiCodexAuth.bearerToken()).rejects.toMatchObject({ status: 500 })
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFallback + 1)
  })

  it('honors cancellation on cached and in-flight refresh paths without publishing', async () => {
    harness = await createHarness()
    const service = harness.root.openaiCodexAuth
    await harness.fiber.dispose()
    const cached: OpenAICodexCredential = {
      access: accessToken('acct_cached'),
      refresh: 'refresh-cached',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_cached',
    }
    await writeCredential(harness.home, cached)
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(service.bearerToken(alreadyAborted.signal))
      .rejects.toThrow('OpenAI login cancelled')

    const expiring = { ...cached, expires: Date.now() + 30_000 }
    await writeCredential(harness.home, expiring)
    harness.credentials.value = cached.access
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const refreshing = service.bearerToken(controller.signal)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(refreshing).rejects.toThrow('OpenAI login cancelled')
    expect(await readCredential(harness.home)).toEqual(expiring)
    expect(harness.credentials.value).toBe(cached.access)
  })

  it('does not publish a cached token after cancellation during credential resolution', async () => {
    harness = await createHarness()
    const service = harness.root.openaiCodexAuth
    await harness.fiber.dispose()
    const cached: OpenAICodexCredential = {
      access: accessToken('acct_cached'),
      refresh: 'refresh-cached',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_cached',
    }
    await writeCredential(harness.home, cached)
    let releaseResolve!: () => void
    const resolveGate = new Promise<void>((resolve) => { releaseResolve = resolve })
    const resolveSpy = vi.spyOn(harness.credentials, 'resolve').mockImplementationOnce(async () => {
      await resolveGate
      return undefined
    })
    const controller = new AbortController()
    const pending = service.bearerToken(controller.signal)
    await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(1))
    controller.abort()
    releaseResolve()

    await expect(pending).rejects.toThrow('OpenAI login cancelled')
    expect(harness.credentials.value).toBeUndefined()
    expect(await readCredential(harness.home)).toEqual(cached)
  })

  it('accepts an equal read-only token but rejects a mismatched credential authority', async () => {
    harness = await createHarness()
    const managed: OpenAICodexCredential = {
      access: accessToken('acct_managed'),
      refresh: 'refresh-managed',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_managed',
    }
    await writeCredential(harness.home, managed)
    harness.credentials.value = managed.access
    harness.credentials.source = 'env'
    harness.credentials.writable = false

    await expect(harness.root.openaiCodexAuth.bearerToken()).resolves.toBe(managed.access)
    harness.credentials.value = accessToken('acct_shadow')
    await expect(harness.root.openaiCodexAuth.bearerToken())
      .rejects.toThrow('does not match the managed OpenAI credential')
    const nativeError = await (harness.root.openaiCodexAuth as any)
      .resolveNativeCredential().catch((error: unknown) => error)
    expect(nativeError).toBeInstanceOf(LlmError)
    expect(nativeError).toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(harness.credentials.value).not.toBe(managed.access)
    expect(await readCredential(harness.home)).toEqual(managed)
  })

  it('resolves one coherent managed credential snapshot for native calls', async () => {
    harness = await createHarness()
    const service = harness.root.openaiCodexAuth as any
    await harness.fiber.dispose()
    const managed: OpenAICodexCredential = {
      access: accessToken('acct_managed'),
      refresh: 'refresh-managed',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_managed',
    }
    await writeCredential(harness.home, managed)

    await expect(service.resolveNativeCredential()).resolves.toEqual({
      accessToken: managed.access,
      accountId: managed.accountId,
    })
    expect(harness.credentials.value).toBe(managed.access)
  })

  it('re-resolves external native authority per operation without importing it into managed state', async () => {
    harness = await createHarness()
    const service = harness.root.openaiCodexAuth as any
    await harness.fiber.dispose()
    const setSpy = vi.spyOn(harness.credentials, 'set')
    const unsetSpy = vi.spyOn(harness.credentials, 'unset')
    harness.credentials.value = accessToken('acct_external_one')
    harness.credentials.source = 'env'
    harness.credentials.writable = false

    await expect(service.resolveNativeCredential()).resolves.toEqual({
      accessToken: harness.credentials.value,
      accountId: 'acct_external_one',
    })
    harness.credentials.value = accessToken('acct_external_two')
    await expect(service.resolveNativeCredential()).resolves.toEqual({
      accessToken: harness.credentials.value,
      accountId: 'acct_external_two',
    })
    expect(setSpy).not.toHaveBeenCalled()
    expect(unsetSpy).not.toHaveBeenCalled()
    await expect(readFile(join(harness.home, 'openai-codex-auth.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns sanitized typed failures for missing, invalid, expired, and cancelled native credentials', async () => {
    harness = await createHarness()
    const service = harness.root.openaiCodexAuth as any
    await harness.fiber.dispose()

    const missing = await service.resolveNativeCredential().catch((error: unknown) => error)
    expect(missing).toBeInstanceOf(LlmError)
    expect(missing).toMatchObject({ code: 'MISSING_CREDENTIAL' })

    const invalidToken = 'not-a-jwt-secret'
    harness.credentials.value = invalidToken
    const invalid = await service.resolveNativeCredential().catch((error: unknown) => error)
    expect(invalid).toBeInstanceOf(LlmError)
    expect(invalid).toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(String((invalid as Error).message)).not.toContain(invalidToken)

    harness.credentials.value = accessToken('acct_expired', Date.now() - 60_000)
    const expired = await service.resolveNativeCredential().catch((error: unknown) => error)
    expect(expired).toBeInstanceOf(LlmError)
    expect(expired).toMatchObject({ code: 'INVALID_CREDENTIAL' })

    const controller = new AbortController()
    controller.abort()
    const aborted = await service.resolveNativeCredential(controller.signal).catch((error: unknown) => error)
    expect(aborted).toBeInstanceOf(LlmError)
    expect(aborted).toMatchObject({ code: 'ABORTED' })
  })

  it('does not return external authority after cancellation during credential resolution', async () => {
    harness = await createHarness()
    const service = harness.root.openaiCodexAuth as any
    await harness.fiber.dispose()
    let releaseResolve!: () => void
    const gate = new Promise<void>((resolve) => { releaseResolve = resolve })
    const external = accessToken('acct_external')
    vi.spyOn(harness.credentials, 'resolve').mockImplementationOnce(async () => {
      await gate
      return { value: external, source: 'env' }
    })
    const controller = new AbortController()
    const pending = service.resolveNativeCredential(controller.signal) as Promise<unknown>
    await vi.waitFor(() => expect(harness!.credentials.resolve).toHaveBeenCalledTimes(1))
    controller.abort()
    releaseResolve()

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await expect(readFile(join(harness.home, 'openai-codex-auth.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('forces one managed refresh and persists rotated native authority', async () => {
    harness = await createHarness()
    const old: OpenAICodexCredential = {
      access: accessToken('acct_old'),
      refresh: 'refresh-old',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_old',
    }
    await writeCredential(harness.home, old)
    harness.credentials.value = old.access
    const nextAccess = accessToken('acct_new')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: nextAccess,
      refresh_token: 'refresh-new',
      expires_in: 3600,
      id_token: idToken('acct_new'),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect((harness.root.openaiCodexAuth as any).recoverNativeCredential({
      accessToken: old.access,
      accountId: old.accountId,
    })).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      client_id: expect.any(String),
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
    })
    expect(await readCredential(harness.home)).toMatchObject({
      access: nextAccess,
      refresh: 'refresh-new',
      accountId: 'acct_new',
    })
    expect(harness.credentials.value).toBe(nextAccess)
  })

  it('reconciles an already-rotated managed authority without another refresh', async () => {
    harness = await createHarness()
    const previous = accessToken('acct_previous')
    const current: OpenAICodexCredential = {
      access: accessToken('acct_current'),
      refresh: 'refresh-current',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_current',
    }
    await writeCredential(harness.home, current)
    harness.credentials.value = previous
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect((harness.root.openaiCodexAuth as any).recoverNativeCredential({
      accessToken: previous,
      accountId: 'acct_previous',
    })).resolves.toBe(true)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(harness.credentials.value).toBe(current.access)
    expect(await readCredential(harness.home)).toEqual(current)
  })

  it('detects external rotation per operation without importing external authority', async () => {
    harness = await createHarness()
    const previous = accessToken('acct_external_old')
    const current = accessToken('acct_external_new')
    harness.credentials.value = current
    harness.credentials.source = 'env'
    harness.credentials.writable = false
    const setSpy = vi.spyOn(harness.credentials, 'set')
    const unsetSpy = vi.spyOn(harness.credentials, 'unset')
    const service = harness.root.openaiCodexAuth as any

    await expect(service.recoverNativeCredential({
      accessToken: previous,
      accountId: 'acct_external_old',
    })).resolves.toBe(true)
    await expect(service.recoverNativeCredential({
      accessToken: current,
      accountId: 'acct_external_new',
    })).resolves.toBe(false)

    expect(setSpy).not.toHaveBeenCalled()
    expect(unsetSpy).not.toHaveBeenCalled()
    await expect(readFile(join(harness.home, 'openai-codex-auth.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets cancellation win during external recovery without importing authority', async () => {
    harness = await createHarness()
    const service = harness.root.openaiCodexAuth as any
    await harness.fiber.dispose()
    let releaseResolve!: () => void
    const gate = new Promise<void>((resolve) => { releaseResolve = resolve })
    const external = accessToken('acct_external')
    const resolveSpy = vi.spyOn(harness.credentials, 'resolve').mockImplementationOnce(async () => {
      await gate
      return { value: external, source: 'env' }
    })
    const setSpy = vi.spyOn(harness.credentials, 'set')
    const unsetSpy = vi.spyOn(harness.credentials, 'unset')
    const controller = new AbortController()
    const pending = service.recoverNativeCredential({
      accessToken: accessToken('acct_previous'),
      accountId: 'acct_previous',
    }, controller.signal) as Promise<unknown>
    await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(1))
    controller.abort()
    releaseResolve()

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(setSpy).not.toHaveBeenCalled()
    expect(unsetSpy).not.toHaveBeenCalled()
    await expect(readFile(join(harness.home, 'openai-codex-auth.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves managed authority and returns sanitized typed refresh failures', async () => {
    harness = await createHarness()
    const current: OpenAICodexCredential = {
      access: accessToken('acct_current'),
      refresh: 'refresh-current',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_current',
    }
    await writeCredential(harness.home, current)
    harness.credentials.value = current.access
    const service = harness.root.openaiCodexAuth as any
    const previous = { accessToken: current.access, accountId: current.accountId }
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        error: 'invalid_grant',
      }), { status: 400, headers: { 'content-type': 'application/json' } })))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        error: 'temporary_failure',
      }), { status: 500, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)

    const terminal = await service.recoverNativeCredential(previous).catch((error: unknown) => error)
    expect(terminal).toBeInstanceOf(LlmError)
    expect(terminal).toMatchObject({ code: 'INVALID_CREDENTIAL', failure: { status: 400 } })
    expect(terminal.message).not.toContain('invalid_grant')
    expect(await readCredential(harness.home)).toEqual(current)
    expect(harness.credentials.value).toBe(current.access)

    const transient = await service.recoverNativeCredential(previous).catch((error: unknown) => error)
    expect(transient).toBeInstanceOf(LlmError)
    expect(transient).toMatchObject({ code: 'AUTH', failure: { status: 500 } })
    expect(transient.message).not.toContain('temporary_failure')
    expect(await readCredential(harness.home)).toEqual(current)
    expect(harness.credentials.value).toBe(current.access)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes usage after a Codex turn and on explicit status refresh without idle polling', async () => {
    harness = await createHarness()
    const token = accessToken()
    await writeFile(join(harness.home, 'openai-codex-auth.json'), JSON.stringify({
      version: 1,
      credential: {
        access: token,
        refresh: 'refresh-token',
        expires: Date.now() + 3_600_000,
        accountId: 'acct_test',
      },
    }))
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 28, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const initial = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    }))
    expect(JSON.parse(initial.body)).toMatchObject({ loggedIn: true })
    expect(JSON.parse(initial.body)).not.toHaveProperty('usage')
    expect(fetchMock).not.toHaveBeenCalled()

    const agent = { id: 'session-usage', session: { id: 'session-usage' } }
    await (harness.root as any).waterfall(agent, 'agent/request', {
      agent, turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ provider: 'openai-codex', model: 'gpt-5.6-sol' }))
    await (harness.root as any).serial(agent, 'agent/turn-stopping', {
      agent, turn: 1, signal: new AbortController().signal,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    const session = { id: 'session-usage' }
    ;(harness.root as any).emit(session, 'session/event', session, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 1, time: Date.now(),
    })

    const cached = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    }))
    expect(JSON.parse(cached.body)).toMatchObject({
      usage: { planType: 'pro', primary: { usedPercent: 28, windowSeconds: 18_000 } },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await (harness.root as any).waterfall(agent, 'agent/request', {
      agent, turn: 2, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ provider: 'anthropic', model: 'claude' }))
    ;(harness.root as any).emit(session, 'session/event', session, {
      type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: 2, time: Date.now(),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status?refresh=1', {
      host: '127.0.0.1:3080',
    }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('runs a trailing refresh when another Codex turn ends during an active usage request', async () => {
    harness = await createHarness()
    await writeFile(join(harness.home, 'openai-codex-auth.json'), JSON.stringify({
      version: 1,
      credential: {
        access: accessToken(),
        refresh: 'refresh-token',
        expires: Date.now() + 3_600_000,
        accountId: 'acct_test',
      },
    }))
    let resolveFirst!: (response: Response) => void
    let resolveSecond!: (response: Response) => void
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve })
    const secondResponse = new Promise<Response>((resolve) => { resolveSecond = resolve })
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockImplementationOnce(() => secondResponse)
    vi.stubGlobal('fetch', fetchMock)
    const agent = { id: 'session-overlap', session: { id: 'session-overlap' } }
    const session = { id: 'session-overlap' }

    await (harness.root as any).waterfall(agent, 'agent/request', {
      agent, turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ provider: 'openai-codex', model: 'gpt-5.6-sol' }))
    ;(harness.root as any).emit(session, 'session/event', session, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 1, time: Date.now(),
    })
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })

    await (harness.root as any).waterfall(agent, 'agent/request', {
      agent, turn: 2, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ provider: 'openai-codex', model: 'gpt-5.6-sol' }))
    ;(harness.root as any).emit(session, 'session/event', session, {
      type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: 2, time: Date.now(),
    })
    let statusSettled = false
    const statusPromise = call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    })).then((value) => {
      statusSettled = true
      return value
    })

    resolveFirst(new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 10 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    expect(statusSettled).toBe(false)
    resolveSecond(new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 22 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const status = await statusPromise
    expect(JSON.parse(status.body)).toHaveProperty('usage.primary.usedPercent', 22)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('preserves prior file, token, and usage when new credential publication fails', async () => {
    harness = await createHarness()
    await writeFile(join(harness.home, 'openai-codex-auth.json'), JSON.stringify({
      version: 1,
      credential: {
        access: accessToken('acct_old'),
        refresh: 'old-refresh',
        expires: Date.now() + 3_600_000,
        accountId: 'acct_old',
      },
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 91 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const seeded = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status?refresh=1', {
      host: '127.0.0.1:3080',
    }))
    expect(JSON.parse(seeded.body)).toHaveProperty('usage.primary.usedPercent', 91)

    vi.spyOn(harness.credentials, 'set').mockRejectedValueOnce(new Error('credential publication failed'))
    await expect((harness.root.openaiCodexAuth as any).finishCredential({
      access: accessToken('acct_new'),
      refresh: 'new-refresh',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_new',
    }, new AbortController().signal)).rejects.toThrow('credential publication failed')

    const status = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    }))
    expect(JSON.parse(status.body)).toMatchObject({
      loggedIn: true,
      accountId: 'acct_old',
      usage: { primary: { usedPercent: 91 } },
    })
    expect(harness.credentials.value).toBe(accessToken('acct_old'))
    expect(await readCredential(harness.home)).toMatchObject({ accountId: 'acct_old' })
  })

  it('does not roll back over an independent credential authority update', async () => {
    harness = await createHarness()
    const oldCredential: OpenAICodexCredential = {
      access: accessToken('acct_old'),
      refresh: 'refresh-old',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_old',
    }
    const nextCredential: OpenAICodexCredential = {
      access: accessToken('acct_next'),
      refresh: 'refresh-next',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_next',
    }
    const independentAccess = accessToken('acct_independent')
    await writeCredential(harness.home, oldCredential)
    harness.credentials.value = oldCredential.access
    const service = harness.root.openaiCodexAuth as any
    vi.spyOn(service, 'write').mockImplementationOnce(async () => {
      harness!.credentials.value = independentAccess
      throw new Error('simulated auth-file write failure')
    })

    await expect(service.finishCredential(nextCredential, new AbortController().signal))
      .rejects.toThrow('credential authority changed')
    expect(harness.credentials.value).toBe(independentAccess)
    expect(await readCredential(harness.home)).toEqual(oldCredential)
  })

  it('does not let an older logout erase a newly published login', async () => {
    harness = await createHarness()
    const oldCredential: OpenAICodexCredential = {
      access: accessToken('acct_old'),
      refresh: 'refresh-old',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_old',
    }
    const nextCredential: OpenAICodexCredential = {
      access: accessToken('acct_new'),
      refresh: 'refresh-new',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_new',
    }
    await writeCredential(harness.home, oldCredential)
    harness.credentials.value = oldCredential.access
    let enterUnset!: () => void
    let releaseUnset!: () => void
    const unsetEntered = new Promise<void>((resolve) => { enterUnset = resolve })
    const unsetGate = new Promise<void>((resolve) => { releaseUnset = resolve })
    const originalUnset = harness.credentials.unset.bind(harness.credentials)
    vi.spyOn(harness.credentials, 'unset').mockImplementationOnce(async () => {
      enterUnset()
      await unsetGate
      await originalUnset()
    })

    const service = harness.root.openaiCodexAuth as any
    const logout = service.logout() as Promise<void>
    await unsetEntered
    const login = service.finishCredential(nextCredential, new AbortController().signal) as Promise<void>
    releaseUnset()
    await Promise.all([logout, login])

    expect(await readCredential(harness.home)).toEqual(nextCredential)
    expect(harness.credentials.value).toBe(nextCredential.access)
  })

  it('starts, redacts, and cancels a device-code flow', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'device-secret', user_code: 'ABCD-EFGH', interval: 5,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    harness = await createHarness()
    const statusBefore = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    }))
    const csrf = JSON.parse(statusBefore.body).csrf as string
    const start = await call(harness.web, '/openai-codex/device/start', request('POST', '/openai-codex/device/start', {
      host: '127.0.0.1:3080', 'x-dsh-csrf': csrf,
    }))
    expect(start.statusCode).toBe(200)
    expect(JSON.parse(start.body)).toMatchObject({
      userCode: 'ABCD-EFGH', verificationUri: 'https://auth.openai.com/codex/device',
    })
    const statusPending = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    }))
    expect(statusPending.body).not.toContain('device-secret')
    expect(JSON.parse(statusPending.body)).toMatchObject({
      loginPending: true,
      loginMethod: 'device',
      device: { userCode: 'ABCD-EFGH' },
    })
    const cancel = await call(harness.web, '/openai-codex/cancel', request('POST', '/openai-codex/cancel', {
      host: '127.0.0.1:3080', 'x-dsh-csrf': csrf,
    }))
    expect(cancel.statusCode).toBe(200)
    expect(JSON.parse(cancel.body)).toEqual({ ok: true })
  })

  it('reuses one in-flight device-code request across concurrent starts', async () => {
    let releaseUserCode!: (response: Response) => void
    const userCodeResponse = new Promise<Response>((resolvePromise) => { releaseUserCode = resolvePromise })
    const fetchMock = vi.fn()
      .mockReturnValueOnce(userCodeResponse)
      .mockResolvedValueOnce(new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    harness = await createHarness()
    const initial = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    }))
    const csrf = JSON.parse(initial.body).csrf as string
    const first = call(harness.web, '/openai-codex/device/start', request('POST', '/openai-codex/device/start', {
      host: '127.0.0.1:3080', 'x-dsh-csrf': csrf,
    }))
    const second = call(harness.web, '/openai-codex/device/start', request('POST', '/openai-codex/device/start', {
      host: '127.0.0.1:3080', 'x-dsh-csrf': csrf,
    }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    releaseUserCode(new Response(JSON.stringify({
      device_auth_id: 'single-device-id', user_code: 'ONE-CODE', interval: 5,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const [firstResponse, secondResponse] = await Promise.all([first, second])
    expect(firstResponse.body).toBe(secondResponse.body)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ client_id: expect.any(String) })
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({
      device_auth_id: 'single-device-id', user_code: 'ONE-CODE',
    })
    await call(harness.web, '/openai-codex/cancel', request('POST', '/openai-codex/cancel', {
      host: '127.0.0.1:3080', 'x-dsh-csrf': csrf,
    }))
  })

  it('reports device-code workspace unavailability as a browser-fallback conflict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    harness = await createHarness()
    const initial = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    }))
    const csrf = JSON.parse(initial.body).csrf as string
    const start = await call(harness.web, '/openai-codex/device/start', request('POST', '/openai-codex/device/start', {
      host: '127.0.0.1:3080', 'x-dsh-csrf': csrf,
    }))
    expect(start.statusCode).toBe(409)
    expect(JSON.parse(start.body)).toMatchObject({ code: 'device_code_unavailable' })
  })

  it('keeps status and logout usable when the credential document is corrupt', async () => {
    harness = await createHarness()
    await writeFile(join(harness.home, 'openai-codex-auth.json'), '{not-json', 'utf8')
    const status = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    }))
    expect(status.statusCode).toBe(200)
    const value = JSON.parse(status.body)
    expect(value).toMatchObject({ loggedIn: false, credentialError: expect.any(String) })
    const logout = await call(harness.web, '/openai-codex/logout', request('POST', '/openai-codex/logout', {
      host: '127.0.0.1:3080', 'x-dsh-csrf': value.csrf,
    }))
    expect(logout.statusCode).toBe(200)
  })

  it('completes device-code login and persists the credential', async () => {
    const token = accessToken()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'device-id', user_code: 'WXYZ-1234', interval: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: 'authorization-code', code_verifier: 'code-verifier',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: token, refresh_token: 'refresh-token', expires_in: 3600, id_token: idToken(),
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValue(new Response(JSON.stringify({ rate_limit: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })))
    harness = await createHarness()
    const initial = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    }))
    const csrf = JSON.parse(initial.body).csrf as string
    const start = await call(harness.web, '/openai-codex/device/start', request('POST', '/openai-codex/device/start', {
      host: '127.0.0.1:3080', 'x-dsh-csrf': csrf,
    }))
    expect(start.statusCode).toBe(200)
    await vi.waitFor(() => expect(harness!.credentials.value).toBe(token))
    const document = JSON.parse(await readFile(join(harness.home, 'openai-codex-auth.json'), 'utf8'))
    expect(document.credential).toMatchObject({ refresh: 'refresh-token', accountId: 'acct_test' })
    const status = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: '127.0.0.1:3080',
    }))
    expect(JSON.parse(status.body)).toMatchObject({ loggedIn: true, loginPending: false, accountId: 'acct_test' })
  })

  it('uses the registered Codex callback and preserves a valid flow on host mismatch', async () => {
    harness = await createHarness()
    const start = await call(harness.web, '/openai-codex/browser/start', request('GET', '/openai-codex/browser/start', {
      host: 'localhost:8080',
    }))
    expect(start.statusCode).toBe(302)
    const authorize = new URL(start.headers.location!)
    expect(authorize.searchParams.get('redirect_uri'))
      .toBe('http://localhost:1455/auth/callback')
    expect(authorize.searchParams.get('scope'))
      .toBe('openid profile email offline_access api.connectors.read api.connectors.invoke')
    const state = authorize.searchParams.get('state')!
    const mismatch = await localBrowserCallback(`/auth/callback?code=x&state=${state}`, '127.0.0.1:1455')
    expect(mismatch.status).toBe(400)
    const reused = await call(harness.web, '/openai-codex/browser/start', request('GET', '/openai-codex/browser/start', {
      host: 'localhost:8080',
    }))
    expect(reused.statusCode).toBe(302)
    expect(reused.headers.location).toBe(start.headers.location)
    const status = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: 'localhost:8080',
    }))
    const cancel = await call(harness.web, '/openai-codex/cancel', request('POST', '/openai-codex/cancel', {
      host: 'localhost:8080', 'x-dsh-csrf': JSON.parse(status.body).csrf,
    }))
    expect(cancel.statusCode).toBe(200)
    await expect(localBrowserCallback('/auth/callback')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('prepares browser diagnostics, serves a CORS probe, and accepts a pasted callback URL', async () => {
    const token = accessToken('acct_manual')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: token, refresh_token: 'manual-refresh', expires_in: 3600, id_token: idToken('acct_manual'),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    harness = await createHarness()
    const initial = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: 'localhost:8080',
    }))
    const csrf = JSON.parse(initial.body).csrf as string
    const rejectedPrepare = await call(harness.web, '/openai-codex/browser/prepare', request('POST', '/openai-codex/browser/prepare', {
      host: 'localhost:8080',
    }))
    expect(rejectedPrepare.statusCode).toBe(403)
    const prepare = await call(harness.web, '/openai-codex/browser/prepare', request('POST', '/openai-codex/browser/prepare', {
      host: 'localhost:8080', 'x-dsh-csrf': csrf,
    }))
    expect(prepare.statusCode).toBe(200)
    const browser = JSON.parse(prepare.body) as { authorizationUrl: string; probeUrl: string; expiresAt: number }
    expect(browser.probeUrl).toMatch(/^http:\/\/127\.0\.0\.1:1455\/openai-codex\/probe\?token=/)
    const authorize = new URL(browser.authorizationUrl)
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    const pending = await call(harness.web, '/openai-codex/status', request('GET', '/openai-codex/status', {
      host: 'localhost:8080',
    }))
    expect(JSON.parse(pending.body)).toMatchObject({
      loginPending: true,
      loginMethod: 'browser',
      browser: { authorizationUrl: browser.authorizationUrl, probeUrl: browser.probeUrl },
    })
    const probeUrl = new URL(browser.probeUrl)
    const rejectedProbe = await localBrowserCallback(probeUrl.pathname + probeUrl.search, '127.0.0.1:1455', '127.0.0.1', {
      origin: 'https://evil.example.com',
    })
    expect(rejectedProbe.status).toBe(403)
    const probe = await localBrowserCallback(probeUrl.pathname + probeUrl.search, '127.0.0.1:1455', '127.0.0.1', {
      origin: 'http://localhost:8080',
    })
    expect(probe).toMatchObject({ status: 200, body: '{"ok":true}' })
    expect(probe.headers['access-control-allow-origin']).toBe('http://localhost:8080')
    const state = authorize.searchParams.get('state')!
    const wrongState = await call(harness.web, '/openai-codex/browser/complete', jsonRequest('POST', '/openai-codex/browser/complete', {
      host: 'localhost:8080', 'x-dsh-csrf': csrf,
    }, { input: 'http://localhost:1455/auth/callback?code=wrong&state=wrong' }))
    expect(wrongState.statusCode).toBe(400)
    const complete = await call(harness.web, '/openai-codex/browser/complete', jsonRequest('POST', '/openai-codex/browser/complete', {
      host: 'localhost:8080', 'x-dsh-csrf': csrf,
    }, { input: `http://localhost:1455/auth/callback?code=manual-code&state=${state}` }))
    expect(complete.statusCode).toBe(200)
    expect(JSON.parse(complete.body)).toEqual({ ok: true })
    expect(harness.credentials.value).toBe(token)
    const exchangeBody = fetchMock.mock.calls[0]![1]!.body as URLSearchParams
    expect(exchangeBody.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    await expect(localBrowserCallback('/auth/callback')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('receives the registered localhost callback, exchanges with the same URI, and closes port 1455', async () => {
    const token = accessToken('acct_browser')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: token, refresh_token: 'browser-refresh', expires_in: 3600, id_token: idToken('acct_browser'),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    harness = await createHarness()
    const start = await call(harness.web, '/openai-codex/browser/start', request('GET', '/openai-codex/browser/start', {
      host: 'localhost:3080',
    }))
    const authorize = new URL(start.headers.location!)
    const state = authorize.searchParams.get('state')!
    try {
      const ipv6 = await localBrowserCallback('/auth/callback?code=ignored&state=wrong', 'localhost:1455', '::1')
      expect(ipv6.status).toBe(400)
    } catch (error) {
      expect(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'ECONNREFUSED']).toContain((error as NodeJS.ErrnoException).code)
    }
    const callback = await localBrowserCallback(`/auth/callback?code=browser-code&state=${state}`)
    expect(callback).toMatchObject({ status: 200, body: 'OpenAI login complete. You may close this window.' })
    expect(harness.credentials.value).toBe(token)
    const exchange = fetchMock.mock.calls[0]!
    expect(exchange[0]).toBe('https://auth.openai.com/oauth/token')
    const body = exchange[1]!.body as URLSearchParams
    expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    await expect(localBrowserCallback('/auth/callback')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})
