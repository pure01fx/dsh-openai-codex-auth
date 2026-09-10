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
  it.each([false, true])('enforces streamed and declared response byte caps (declared=%s)', async declared => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('123456')) }, cancel }), { headers: declared ? { 'content-length': '1000' } : {} })
    const { client } = setup(vi.fn<typeof fetch>().mockResolvedValue(response))
    await expect(client.post('alpha/search', {}, { credential, signal: signal(), maxResponseBytes: 5 })).rejects.toThrow('byte limit')
    expect(cancel).toHaveBeenCalled()
  })
  it('sanitizes interrupted image streams without retrying', async () => {
    const stream = new ReadableStream({ start(c) { c.error(new LlmError('test-secret-token', 'BAD_STREAM')) } })
    const { client, fetchImpl } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)))
    await expect(client.post('images/edits', {}, { credential, signal: signal() })).rejects.toThrow('response interrupted; it was not retried')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('rejects oversized requests before fetch', async () => {
    const { client, fetchImpl } = setup(undefined, { maxRequestBodyBytes: 5 })
    await expect(client.post('alpha/search', { big: 'payload' }, { credential, signal: signal() })).rejects.toThrow('byte limit')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('sanitizes invalid JSON, resolver and endpoint errors', async () => {
    const { client } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response('test-secret-token')))
    await expect(client.post('alpha/search', {}, { credential, signal: signal() })).rejects.toThrow('invalid JSON')
    const broken = new NativeCodexCloudClient({ resolveCredential: async () => { throw new Error('test-secret-token') } })
    await expect(broken.resolveCredential()).rejects.toThrow('credential unavailable')
    expect(() => new NativeCodexCloudClient({ resolveCredential: async () => credential, endpoint: 'https://evil.example/test-secret-token' })).toThrow('Invalid Codex cloud endpoint')
  })
})
