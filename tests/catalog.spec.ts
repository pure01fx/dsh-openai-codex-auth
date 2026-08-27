import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  CODEX_CATALOG_CACHE_TTL_MS,
  CODEX_CLIENT_VERSION,
  NativeCodexCatalog,
  nativeCodexAuthorityHash,
  type NativeCodexCredential,
} from '../src/catalog.ts'

const FIXTURE = await readFile(new URL('./fixtures/codex-models-d5cacec.json', import.meta.url), 'utf8')
const CREDENTIAL: NativeCodexCredential = {
  accessToken: 'fixture-secret-token',
  accountId: 'acct_fixture',
}

function response(body = FIXTURE, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', etag: 'W/"fixture-etag"' },
    ...init,
  })
}

describe('NativeCodexCatalog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the pinned request shape and retains a secret-free account-partitioned ETag snapshot', async () => {
    const fetchMock = vi.fn(async () => response())
    const catalog = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
    })

    expect(await catalog.list()).toEqual([
      {
        slug: 'gpt-test',
        displayName: 'gpt-test',
        description: 'desc',
        defaultReasoningLevel: 'medium',
        supportedReasoningLevels: [
          { effort: 'low', description: 'low' },
          { effort: 'medium', description: 'medium' },
          { effort: 'high', description: 'high' },
        ],
        visibility: 'list',
        supportedInApi: true,
        priority: 1,
        additionalSpeedTiers: [],
        serviceTiers: [],
        contextWindow: 272000,
        inputModalities: ['text', 'image'],
      },
    ])
    expect(catalog.etag()).toBe('W/"fixture-etag"')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input, init] = fetchMock.mock.calls[0]!
    expect(String(input)).toBe(
      'https://chatgpt.com/backend-api/codex/models?client_version=' + CODEX_CLIENT_VERSION,
    )
    expect(init?.method).toBe('GET')
    const headers = new Headers(init?.headers)
    expect(Object.fromEntries(headers.entries())).toMatchObject({
      authorization: 'Bearer ' + CREDENTIAL.accessToken,
      'chatgpt-account-id': CREDENTIAL.accountId,
      originator: 'dsh',
    })
    expect(headers.get('user-agent')).toContain('deepseek-harness/')
    expect(headers.has('accept')).toBe(false)
    expect(headers.has('content-type')).toBe(false)
    expect(headers.has('openai-beta')).toBe(false)
    expect(headers.has('if-none-match')).toBe(false)

    const snapshot = JSON.stringify(catalog)
    expect(snapshot).not.toContain(CREDENTIAL.accessToken)
    expect(snapshot).not.toContain(CREDENTIAL.accountId)
    expect((JSON.parse(snapshot) as { snapshot: { etag: string } }).snapshot.etag)
      .toBe('W/"fixture-etag"')
    await expect(catalog.listWithAuthority()).resolves.toMatchObject({
      authorityHash: nativeCodexAuthorityHash(CREDENTIAL.accountId),
    })
  })

  it('retains service-tier discovery and Codex context/modality fallbacks', async () => {
    const fetchMock = vi.fn(async () => response(JSON.stringify({
      models: [{
        slug: 'tiered/model',
        display_name: 'Tiered Model',
        supported_reasoning_levels: [],
        shell_type: 'shell_command',
        visibility: 'list',
        priority: 3,
        supported_in_api: false,
        context_window: null,
        max_context_window: 128000,
        input_modalities: ['text', 'audio', 'image'],
        additional_speed_tiers: ['fast'],
        service_tiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }],
        default_service_tier: 'default',
      }],
    })))
    const catalog = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
    })

    expect(await catalog.list()).toEqual([{
      slug: 'tiered/model',
      displayName: 'Tiered Model',
      supportedReasoningLevels: [],
      visibility: 'list',
      supportedInApi: false,
      priority: 3,
      additionalSpeedTiers: ['fast'],
      serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }],
      defaultServiceTier: 'default',
      contextWindow: 128000,
      inputModalities: ['text', 'audio', 'image'],
    }])
  })

  it('re-resolves credentials while reusing fresh memory cache only for its account', async () => {
    let credential = CREDENTIAL
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    const resolveCredential = vi.fn(async () => credential)
    const catalog = new NativeCodexCatalog({
      resolveCredential,
      fetch: fetchMock as typeof fetch,
    })
    const expected = await catalog.list()
    expect(await catalog.list()).toEqual(expected)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(resolveCredential).toHaveBeenCalledTimes(2)

    credential = { ...CREDENTIAL, accountId: 'acct_other' }
    expect(await catalog.list()).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    credential = CREDENTIAL
    expect(await catalog.list()).toEqual(expected)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const newInstanceFetch = vi.fn(async () => response())
    const newInstance = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: newInstanceFetch as typeof fetch,
    })
    expect(await newInstance.list()).toEqual(expected)
    expect(newInstanceFetch).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent refreshes while resolving credentials per operation', async () => {
    let releaseFetch!: () => void
    const fetchGate = new Promise<Response>((resolve) => {
      releaseFetch = () => { resolve(response()) }
    })
    const fetchMock = vi.fn(() => fetchGate)
    const resolveCredential = vi.fn(async () => CREDENTIAL)
    const catalog = new NativeCodexCatalog({
      resolveCredential,
      fetch: fetchMock as typeof fetch,
    })

    const first = catalog.list()
    const second = catalog.list()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    releaseFetch()
    const [firstModels, secondModels] = await Promise.all([first, second])
    expect(secondModels).toEqual(firstModels)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(resolveCredential).toHaveBeenCalledTimes(2)
  })

  it('uses bounded stale cache on recoverable refresh failures without advancing it', async () => {
    let now = 1_000_000
    const warnings: string[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(response(JSON.stringify({ models: [] })))
    const catalog = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
      now: () => now,
      warn: message => { warnings.push(message) },
    })
    const expected = await catalog.list()

    now += CODEX_CATALOG_CACHE_TTL_MS + 1
    expect(await catalog.list()).toEqual(expected)
    expect(warnings.at(-1)).toContain('CATALOG_HTTP_ERROR')

    now += 1
    expect(await catalog.list()).toEqual(expected)
    expect(warnings.at(-1)).toContain('CATALOG_EMPTY')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps last-known-good metadata when a refresh is partial, duplicate, or not visible', async () => {
    let now = 1_000_000
    const valid = (JSON.parse(FIXTURE) as { models: unknown[] }).models[0]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(JSON.stringify({ models: [valid, { slug: 'broken' }] })))
      .mockResolvedValueOnce(response(JSON.stringify({ models: [valid, valid] })))
      .mockResolvedValueOnce(response(JSON.stringify({
        models: [{ ...(valid as Record<string, unknown>), visibility: 'hide' }],
      })))
    const warnings: string[] = []
    const catalog = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
      now: () => now,
      warn: message => { warnings.push(message) },
    })
    const expected = await catalog.list()

    for (const expectedCode of ['CATALOG_INVALID_RESPONSE', 'CATALOG_INVALID_RESPONSE', 'CATALOG_EMPTY']) {
      now += CODEX_CATALOG_CACHE_TTL_MS + 1
      expect(await catalog.list()).toEqual(expected)
      expect(warnings.at(-1)).toContain(expectedCode)
    }
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('rejects stale metadata beyond the configured bound', async () => {
    let now = 1_000_000
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    const catalog = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
      now: () => now,
      maxStaleMs: CODEX_CATALOG_CACHE_TTL_MS + 5,
    })
    await catalog.list()
    now += CODEX_CATALOG_CACHE_TTL_MS + 6

    expect(await catalog.list()).toEqual([])
  })

  it('does not use stale metadata for credential failures and degrades discovery to empty', async () => {
    let now = 1_000_000
    const warnings: string[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    const catalog = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: fetchMock as typeof fetch,
      now: () => now,
      warn: message => { warnings.push(message) },
    })
    await catalog.list()
    now += CODEX_CATALOG_CACHE_TTL_MS + 1

    expect(await catalog.list()).toEqual([])
    expect(warnings.at(-1)).toContain('INVALID_CREDENTIAL')
  })

  it('rejects an oversized catalog before parsing and degrades metadata safely', async () => {
    const warnings: string[] = []
    const catalog = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: vi.fn(async () => response('x'.repeat(2 * 1024 * 1024 + 1))) as typeof fetch,
      warn: message => { warnings.push(message) },
    })

    await expect(catalog.list()).resolves.toEqual([])
    expect(warnings.at(-1)).toContain('CATALOG_INVALID_RESPONSE')
  })

  it('honors caller abort and applies a bounded timeout to discovery', async () => {
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const unusedFetch = vi.fn(async () => response())
    const catalog = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: unusedFetch as typeof fetch,
    })
    await expect(catalog.list(alreadyAborted.signal)).rejects.toMatchObject<LlmError>({ code: 'ABORTED' })
    expect(unusedFetch).not.toHaveBeenCalled()

    const hangingFetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const warnings: string[] = []
    const timed = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: hangingFetch as typeof fetch,
      timeoutMs: 5,
      warn: message => { warnings.push(message) },
    })
    await expect(timed.list()).resolves.toEqual([])
    expect(warnings.at(-1)).toContain('CATALOG_TIMEOUT')

    const inFlightFetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const cancellable = new NativeCodexCatalog({
      resolveCredential: async () => CREDENTIAL,
      fetch: inFlightFetch as typeof fetch,
    })
    const controller = new AbortController()
    const inFlight = cancellable.list(controller.signal)
    await vi.waitFor(() => expect(inFlightFetch).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(inFlight).rejects.toMatchObject<LlmError>({ code: 'ABORTED' })
  })
})
