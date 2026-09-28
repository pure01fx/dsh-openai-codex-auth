import { describe, expect, it, vi } from 'vitest'
import { NativeCodexCloudClient } from '../src/cloud-http.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
const credential = { accessToken: 'test-secret-token', accountId: 'acct-a' }
const signal = () => new AbortController().signal
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'x-request-id': 'req-123' } })
function setup(fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ ok: true })), extra = {}) {
  const resolveCredential = vi.fn().mockResolvedValue(credential)
  return { fetchImpl, resolveCredential, client: new NativeCodexCloudClient({ fetch: fetchImpl, resolveCredential, ...extra }) }
}
describe('cloud HTTP', () => {
  it.each(['alpha/search', 'images/generations', 'images/edits'] as const)('posts exact authenticated JSON to %s', async path => {
    const { client, fetchImpl, resolveCredential } = setup()
    const resolved = await client.resolveCredential()
    expect(resolved).toEqual(credential)
    const body = { model: 'model', prompt: 'example', nested: { n: 1 } }
    expect(await client.post(path, body, { credential: resolved, signal: signal(), headers: { Authorization: 'bad', 'chatgpt-account-id': 'bad', 'x-client-request-id': 'session-hash' } })).toEqual({ body: { ok: true }, requestId: 'req-123' })
    expect(resolveCredential).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://chatgpt.com/backend-api/codex/' + path)
    expect({ method: init!.method, redirect: init!.redirect, body: init!.body }).toEqual({ method: 'POST', redirect: 'error', body: JSON.stringify(body) })
    const h = new Headers(init!.headers)
    expect({ auth: h.get('authorization'), account: h.get('chatgpt-account-id'), accept: h.get('accept'), type: h.get('content-type'), originator: h.get('originator'), id: h.get('x-client-request-id') }).toEqual({ auth: 'Bearer test-secret-token', account: 'acct-a', accept: 'application/json', type: 'application/json', originator: 'dsh', id: 'session-hash' })
  })
  describe.each(['images/generations', 'images/edits'] as const)('%s request diagnostics', path => {
    const headerCases: { headers: Record<string, string>; expected: string }[] = [
      { headers: { 'x-codex-imagegen-request-id': 'image-123', 'x-request-id': 'generic-456' }, expected: 'image-123' },
      { headers: { 'x-request-id': 'generic-456' }, expected: 'generic-456' },
    ]
    it.each(headerCases)('preserves successful header priority: $expected', async ({ headers, expected }) => {
      const { client } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers })))
      expect(await client.post(path, {}, { credential, signal: signal() })).toEqual({ body: {}, requestId: expected })
    })
    describe.each(headerCases)('failure header priority: $expected', ({ headers, expected }) => {
      it.each([401, 429, 500, 502, 307, 200])('retains requestId and status %s without retrying', async status => {
        const { client, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response('test-secret-token', { status, headers })))
        const error = await client.post(path, {}, { credential, signal: signal() }).catch(error => error)
        expect(error).toBeInstanceOf(LlmError)
        expect(error.failure).toMatchObject({ status, requestId: expected })
        expect(error.code).toBe(status === 200 ? 'CODEX_CLOUD_FAILED' : status === 401 ? 'AUTH_REQUIRED' : 'CODEX_CLOUD_HTTP_ERROR')
        expect(error.message).toBe(status === 200 ? 'Codex cloud service returned invalid JSON' : 'Codex cloud service returned HTTP ' + status)
        expect(JSON.stringify(error)).not.toContain(credential.accessToken)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
      })
    })
    it('retains response facts on invalid UTF-8', async () => {
      const { client, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([0xff]), {
        headers: { 'x-codex-imagegen-request-id': 'image-utf8' },
      })))
      await expect(client.post(path, {}, { credential, signal: signal() })).rejects.toMatchObject({
        code: 'CODEX_CLOUD_FAILED', failure: { status: 200, requestId: 'image-utf8' },
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })
    describe.each(['x-codex-imagegen-request-id', 'x-request-id'])('unsafe %s', header => {
      it.each(['', 'bad id', 'bad/id', 'a'.repeat(257), credential.accessToken, 'prefix-' + credential.accessToken, credential.accountId])('drops unsafe ID %j on success and failures', async value => {
        for (const [status, body] of [[200, '{}'], [200, 'invalid'], [500, 'secret']] as const) {
          const headers = { [header]: value, ...(header === 'x-codex-imagegen-request-id' ? { 'x-request-id': 'generic-456' } : {}) }
          const { client, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status, headers })))
          const result = await client.post(path, {}, { credential, signal: signal() }).catch(error => error)
          if (body === '{}') expect(result).toEqual({ body: {} })
          else {
            expect(result).toBeInstanceOf(LlmError)
            expect(result.failure.status).toBe(status)
            expect(result.failure.requestId).toBeUndefined()
            expect(JSON.stringify(result)).not.toContain(credential.accessToken)
            expect(JSON.stringify(result)).not.toContain(credential.accountId)
          }
          expect(fetchImpl).toHaveBeenCalledTimes(1)
        }
      })
    })
  })
  it('rejects echoes of either token after credential recovery', async () => {
    for (const requestId of [credential.accessToken, 'new-token']) {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(new Response('invalid', { headers: { 'x-codex-imagegen-request-id': requestId } }))
      const recoverCredential = vi.fn().mockResolvedValue(true)
      const { client, resolveCredential } = setup(fetchImpl, { recoverCredential })
      resolveCredential.mockResolvedValue({ ...credential, accessToken: 'new-token' })
      const error = await client.post('images/generations', {}, { credential, signal: signal() }).catch(error => error)
      expect(error).toBeInstanceOf(LlmError)
      expect(error.failure.status).toBe(200)
      expect(error.failure.requestId).toBeUndefined()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(recoverCredential).toHaveBeenCalledTimes(1)
    }
  })
  it('recovers a single 401 with a new token for the same account', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(json({ output: 'ok' }))
    const recoverCredential = vi.fn().mockResolvedValue(true)
    const { client, resolveCredential } = setup(fetchImpl, { recoverCredential })
    resolveCredential.mockResolvedValue({ ...credential, accessToken: 'new-token' })
    await client.post('alpha/search', { id: 'stable' }, { credential, signal: signal() })
    expect(recoverCredential).toHaveBeenCalledTimes(1)
    expect(recoverCredential.mock.calls[0]![0]).toEqual(credential)
    expect(new Headers(fetchImpl.mock.calls[1]![1]!.headers).get('authorization')).toBe('Bearer new-token')
    expect(fetchImpl.mock.calls.map(call => call[1]!.body)).toEqual(['{"id":"stable"}', '{"id":"stable"}'])
  })
  it('stops an account switch before retrying', async () => {
    const { client, resolveCredential, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 })), { recoverCredential: async () => true })
    resolveCredential.mockResolvedValue({ accessToken: 'other', accountId: 'acct-b' })
    await expect(client.post('alpha/search', {}, { credential, signal: signal() })).rejects.toMatchObject({ code: 'CODEX_ACCOUNT_CHANGED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('does not recover a second 401', async () => {
    const recoverCredential = vi.fn().mockResolvedValue(true)
    const { client, fetchImpl } = setup(vi.fn<typeof fetch>().mockImplementation(async () => new Response('secret', { status: 401 })), { recoverCredential })
    await expect(client.post('alpha/search', {}, { credential, signal: signal() })).rejects.toThrow('HTTP 401')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(recoverCredential).toHaveBeenCalledTimes(1)
  })
  it.each(['images/generations', 'images/edits'] as const)('does not retry uncertain %s network failure', async path => {
    const { client, fetchImpl } = setup(vi.fn<typeof fetch>().mockRejectedValue(new Error('test-secret-token')))
    await expect(client.post(path, {}, { credential, signal: signal() })).rejects.toThrow('it was not retried')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each([429, 500, 502, 307])('does not retry or expose HTTP %s body', async status => {
    const { client, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response('test-secret-token', { status })))
    await expect(client.post('images/generations', {}, { credential, signal: signal() })).rejects.toThrow('HTTP ' + status)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('honors pre-cancel, in-flight cancel and timeout even with uncooperative fetch', async () => {
    const { client, fetchImpl } = setup(vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})))
    const cancelled = new AbortController(); cancelled.abort(new Error('test-secret-token'))
    await expect(client.post('alpha/search', {}, { credential, signal: cancelled.signal })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetchImpl).not.toHaveBeenCalled()
    const active = new AbortController()
    const pending = client.post('alpha/search', {}, { credential, signal: active.signal })
    active.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await expect(client.post('alpha/search', {}, { credential, signal: signal(), timeoutMs: 5 })).rejects.toMatchObject({ code: 'ABORTED' })
  })
  it('cancels a stalled response body on timeout', async () => {
    const cancel = vi.fn()
    const { client } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }))))
    await expect(client.post('alpha/search', {}, { credential, signal: signal(), timeoutMs: 5 })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(cancel).toHaveBeenCalled()
  })
  it('sanitizes interrupted image streams without retrying', async () => {
    const stream = new ReadableStream({ start(c) { c.error(new LlmError('test-secret-token', 'BAD_STREAM')) } })
    const { client, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)))
    await expect(client.post('images/edits', {}, { credential, signal: signal() })).rejects.toThrow('response interrupted; it was not retried')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('sanitizes invalid JSON, resolver and endpoint errors', async () => {
    const { client } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response('test-secret-token')))
    await expect(client.post('alpha/search', {}, { credential, signal: signal() })).rejects.toThrow('invalid JSON')
    const broken = new NativeCodexCloudClient({ resolveCredential: async () => { throw new Error('test-secret-token') } })
    await expect(broken.resolveCredential()).rejects.toThrow('credential unavailable')
    expect(() => new NativeCodexCloudClient({ resolveCredential: async () => credential, endpoint: 'https://evil.example/test-secret-token' })).toThrow('Invalid Codex cloud endpoint')
  })
})
