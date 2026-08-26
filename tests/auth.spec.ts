import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import OpenAICodexAuth, { internals } from '../src/index.ts'

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

function accessToken(accountId = 'acct_test'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url')
  return `${header}.${payload}.signature`
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

  it('clears prior-account usage as soon as a new credential file is published', async () => {
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
    expect(JSON.parse(status.body)).toMatchObject({ loggedIn: true, accountId: 'acct_new' })
    expect(JSON.parse(status.body)).not.toHaveProperty('usage')
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
        access_token: token, refresh_token: 'refresh-token', expires_in: 3600,
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
      access_token: token, refresh_token: 'manual-refresh', expires_in: 3600,
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
      access_token: token, refresh_token: 'browser-refresh', expires_in: 3600,
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
