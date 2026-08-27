import { Context, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import OpenAICodexAuth from '../src/index.ts'
import type { NativeCodexModel } from '../src/catalog.ts'
import {
  NATIVE_CODEX_PROVIDER,
  NativeCodexAdapter,
} from '../src/native-adapter.ts'

const PI_CODEX_PROVIDER = 'openai-codex'

class RegistrationCredentials {
  value: string | undefined

  async resolve() {
    return this.value === undefined ? undefined : { value: this.value, source: 'env' }
  }

  async describe() { return { configured: this.value !== undefined, source: 'env', writable: false } }
  async set(_ref: unknown, value: string) { this.value = value }
  async unset() { this.value = undefined }
}

class RegistrationWebServer {
  port = 3080
  host = '127.0.0.1' as const
  register() { return () => {} }
}

class ExistingCodexAdapter extends LlmAdapter {
  providerInfo(provider: string) {
    return { id: provider, name: 'Existing pi-ai Codex route' }
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function accessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url')
  return `${header}.${body}.signature`
}

function request(
  provider = NATIVE_CODEX_PROVIDER,
  signal?: AbortSignal,
): GenerateOptions {
  return {
    provider,
    model: 'exact/model-id',
    messages: [],
    ...(signal === undefined ? {} : { signal }),
  }
}

describe('NativeCodexAdapter catalog boundary', () => {
  let ctx: Context
  let runtimeFiber: Fiber

  beforeEach(async () => {
    ctx = new Context()
    runtimeFiber = ctx.plugin(LlmRuntime)
    await runtimeFiber
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await runtimeFiber.dispose()
  })

  it('returns valid fixed-route metadata and advisory exact model identity', async () => {
    const adapter = new NativeCodexAdapter()

    expect(adapter.providerInfo(NATIVE_CODEX_PROVIDER)).toEqual({
      id: NATIVE_CODEX_PROVIDER,
      name: 'OpenAI Codex (Native, Experimental)',
    })
    expect(await adapter.listModels(NATIVE_CODEX_PROVIDER)).toEqual([])
    expect(await adapter.resolveModel(NATIVE_CODEX_PROVIDER, 'vendor/model:exact')).toEqual({
      provider: NATIVE_CODEX_PROVIDER,
      id: 'vendor/model:exact',
      name: 'vendor/model:exact',
    })
    expect(() => adapter.providerInfo(PI_CODEX_PROVIDER)).toThrowError(
      expect.objectContaining({ code: 'NO_ADAPTER' }),
    )
  })

  it('maps visible catalog order and exact hidden-model capabilities', async () => {
    const models: NativeCodexModel[] = [
      {
        slug: 'hidden/model',
        displayName: 'Hidden Model',
        description: 'resolvable but not picker-visible',
        defaultReasoningLevel: 'xhigh',
        supportedReasoningLevels: [
          { effort: 'low', description: 'Low effort' },
          { effort: 'xhigh', description: 'Maximum effort' },
          { effort: 'xhigh', description: 'duplicate ignored' },
          { effort: 'future' },
        ],
        visibility: 'hide',
        supportedInApi: false,
        priority: 0,
        additionalSpeedTiers: ['fast'],
        serviceTiers: [{ id: 'priority', name: 'Fast' }],
        defaultServiceTier: 'default',
        contextWindow: 272000,
        inputModalities: ['audio', 'image', 'text'],
      },
      {
        slug: 'visible/later',
        displayName: 'Visible Later',
        defaultReasoningLevel: 'high',
        supportedReasoningLevels: [{ effort: 'low' }],
        visibility: 'list',
        supportedInApi: true,
        priority: 2,
        additionalSpeedTiers: [],
        serviceTiers: [],
        inputModalities: [],
      },
      {
        slug: 'visible/first',
        displayName: 'Visible First',
        description: 'first by priority even when API-hidden',
        supportedReasoningLevels: [],
        visibility: 'list',
        supportedInApi: false,
        priority: 1,
        additionalSpeedTiers: [],
        serviceTiers: [{ id: 'priority', name: 'Fast' }],
        inputModalities: ['text'],
      },
      {
        slug: 'none/model',
        displayName: 'None Model',
        supportedReasoningLevels: [],
        visibility: 'none',
        supportedInApi: true,
        priority: -1,
        additionalSpeedTiers: [],
        serviceTiers: [],
        inputModalities: ['text'],
      },
    ]
    const catalog = { list: vi.fn(async () => models), etag: () => 'fixture-etag' }
    const adapter = new NativeCodexAdapter(catalog)

    expect(await adapter.listModels(NATIVE_CODEX_PROVIDER)).toEqual([
      {
        provider: NATIVE_CODEX_PROVIDER,
        id: 'visible/first',
        name: 'Visible First',
        description: 'first by priority even when API-hidden',
        inputModalities: ['text'],
      },
      {
        provider: NATIVE_CODEX_PROVIDER,
        id: 'visible/first-fast',
        name: 'Visible First (Fast)',
        description: 'first by priority even when API-hidden',
        inputModalities: ['text'],
      },
      {
        provider: NATIVE_CODEX_PROVIDER,
        id: 'visible/later',
        name: 'Visible Later',
        inputModalities: [],
      },
    ])
    expect(await adapter.resolveModel(NATIVE_CODEX_PROVIDER, 'hidden/model')).toEqual({
      provider: NATIVE_CODEX_PROVIDER,
      id: 'hidden/model',
      name: 'Hidden Model',
      description: 'resolvable but not picker-visible',
      inputModalities: ['image', 'text'],
      context: { contextWindow: 272000 },
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low', description: 'Low effort' },
          { id: 'xhigh', name: 'Extra High', description: 'Maximum effort' },
          { id: 'future', name: 'future' },
        ],
        defaultEffort: 'xhigh',
      },
    })
    await expect(adapter.resolveModel(NATIVE_CODEX_PROVIDER, 'hidden/model-fast')).resolves
      .toMatchObject({
        provider: NATIVE_CODEX_PROVIDER,
        id: 'hidden/model-fast',
        name: 'Hidden Model (Fast)',
        context: { contextWindow: 272000 },
      })
    await expect(adapter.resolveModel(NATIVE_CODEX_PROVIDER, 'visible/later-fast')).rejects
      .toMatchObject({ code: 'FAST_UNSUPPORTED' })
    expect(await adapter.resolveModel(NATIVE_CODEX_PROVIDER, 'visible/later')).toEqual({
      provider: NATIVE_CODEX_PROVIDER,
      id: 'visible/later',
      name: 'Visible Later',
      inputModalities: [],
      reasoning: { efforts: [{ id: 'low', name: 'Low' }] },
    })
    expect(await adapter.resolveModel(NATIVE_CODEX_PROVIDER, 'unknown/exact')).toEqual({
      provider: NATIVE_CODEX_PROVIDER,
      id: 'unknown/exact',
      name: 'unknown/exact',
    })
    const dispose = ctx.llm.registerAdapter([NATIVE_CODEX_PROVIDER], adapter)
    await expect(ctx.llm.resolveModelInfo(NATIVE_CODEX_PROVIDER, 'hidden/model')).resolves
      .toMatchObject({ id: 'hidden/model', reasoning: { defaultEffort: 'xhigh' } })
    dispose()
  })

  it('maps a Fast stream to the base model and never silently downgrades', async () => {
    const fastModel: NativeCodexModel = {
      slug: 'gpt-fast-capable',
      displayName: 'Fast Capable',
      supportedReasoningLevels: [],
      visibility: 'list',
      supportedInApi: false,
      priority: 0,
      additionalSpeedTiers: ['fast'],
      serviceTiers: [],
      inputModalities: ['text'],
    }
    const seen: Array<{
      options: GenerateOptions
      mode?: { serviceTier?: 'priority'; publicModel?: string; authorityHash?: string }
    }> = []
    const transport = {
      async *stream(
        options: GenerateOptions, mode?: { serviceTier?: 'priority'; publicModel?: string; authorityHash?: string },
      ): AsyncIterable<StreamChunk> {
        seen.push({ options, ...(mode === undefined ? {} : { mode }) })
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const adapter = new NativeCodexAdapter(
      {
        list: async () => [fastModel],
        listWithAuthority: async () => ({ models: [fastModel], authorityHash: 'authority-a' }),
        etag: () => undefined,
      },
      transport,
    )

    await expect(collect(adapter.stream({
      ...request(), model: 'gpt-fast-capable-fast',
    }))).resolves.toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.options.model).toBe('gpt-fast-capable')
    expect(seen[0]?.mode).toEqual({
      serviceTier: 'priority', publicModel: 'gpt-fast-capable-fast',
      authorityHash: 'authority-a',
    })

    await expect(collect(adapter.stream({
      ...request(), model: 'missing-fast',
    }))).rejects.toMatchObject({ code: 'FAST_UNSUPPORTED' })
    expect(seen).toHaveLength(1)
  })

  it('refuses Fast when account-bound catalog authority is unavailable', async () => {
    const fastModel = {
      slug: 'account-bound', displayName: 'Account Bound',
      supportedReasoningLevels: [], visibility: 'list' as const, supportedInApi: false,
      priority: 0, additionalSpeedTiers: ['fast'], serviceTiers: [],
      inputModalities: ['text'],
    }
    const stream = vi.fn()
    const adapter = new NativeCodexAdapter(
      { list: async () => [fastModel], etag: () => undefined },
      { stream },
    )
    await expect(collect(adapter.stream({ ...request(), model: 'account-bound-fast' })))
      .rejects.toMatchObject({ code: 'FAST_CAPABILITY_UNAVAILABLE' })
    expect(stream).not.toHaveBeenCalled()
  })

  it('gives exact wire slugs precedence over colliding Fast aliases', async () => {
    const base = {
      slug: 'model', displayName: 'Base', supportedReasoningLevels: [],
      visibility: 'list', supportedInApi: false, priority: 0,
      additionalSpeedTiers: ['fast'], serviceTiers: [], inputModalities: ['text'],
    } satisfies NativeCodexModel
    const exactFastSlug = {
      slug: 'model-fast', displayName: 'Exact Fast-Suffixed Wire Model',
      supportedReasoningLevels: [], visibility: 'list', supportedInApi: false, priority: 1,
      additionalSpeedTiers: [], serviceTiers: [], inputModalities: ['text'],
    } satisfies NativeCodexModel
    const seen: Array<{ model: string; tier?: string }> = []
    const adapter = new NativeCodexAdapter(
      { list: async () => [base, exactFastSlug], etag: () => undefined },
      { async *stream(options, mode) {
        seen.push({
          model: options.model,
          ...(mode?.serviceTier === undefined ? {} : { tier: mode.serviceTier }),
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      } },
    )

    await expect(adapter.listModels(NATIVE_CODEX_PROVIDER)).resolves.toEqual([
      { provider: NATIVE_CODEX_PROVIDER, id: 'model', name: 'Base', inputModalities: ['text'] },
      {
        provider: NATIVE_CODEX_PROVIDER,
        id: 'model-fast',
        name: 'Exact Fast-Suffixed Wire Model',
        inputModalities: ['text'],
      },
    ])
    await expect(adapter.resolveModel(NATIVE_CODEX_PROVIDER, 'model-fast')).resolves.toMatchObject({
      id: 'model-fast', name: 'Exact Fast-Suffixed Wire Model',
    })
    await collect(adapter.stream({ ...request(), model: 'model-fast' }))
    expect(seen).toEqual([{ model: 'model-fast' }])
  })

  it('registers the opt-in route and streams through external authority', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openai-codex-native-registration-'))
    const credentials = new RegistrationCredentials()
    credentials.value = accessToken('acct_registration')
    ctx.provide('credentials', credentials as never)
    ctx.provide('webServer', new RegistrationWebServer() as never)
    ctx.provide('webRuntime', { lanAddresses: [], trustedHosts: [] })
    let responsesBody: Record<string, unknown> | undefined
    let responsesHeaders: Headers | undefined
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).includes('/models?')) {
        return new Response(JSON.stringify({
          models: [{
            slug: 'catalog/model',
            display_name: 'Catalog Model',
            supported_reasoning_levels: [],
            shell_type: 'shell_command',
            visibility: 'list',
            priority: 1,
            supported_in_api: false,
            service_tiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }],
          }],
        }), { status: 200 })
      }
      responsesBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      responsesHeaders = new Headers(init?.headers)
      return new Response([
        'data: {"type":"response.output_text.delta","item_id":"msg-integration","delta":"ok"}',
        '',
        'data: {"type":"response.output_item.done","item":{"type":"message","id":"msg-integration","content":[{"type":"output_text","text":"ok"}]}}',
        '',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
        '',
      ].join('\n'), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const authFiber = await ctx.plugin(OpenAICodexAuth, { dshHome: home, nativeAdapter: true })
    try {
      await vi.waitFor(() => {
        expect(ctx.llm.listProviders()).toContainEqual({
          id: NATIVE_CODEX_PROVIDER,
          name: 'OpenAI Codex (Native, Experimental)',
        })
      })
      await expect(ctx.llm.listModels(NATIVE_CODEX_PROVIDER)).resolves.toEqual([
        {
          provider: NATIVE_CODEX_PROVIDER,
          id: 'catalog/model',
          name: 'Catalog Model',
          inputModalities: ['text', 'image'],
        },
        {
          provider: NATIVE_CODEX_PROVIDER,
          id: 'catalog/model-fast',
          name: 'Catalog Model (Fast)',
          inputModalities: ['text', 'image'],
        },
      ])
      await expect(collect(ctx.llm.stream({
        ...request(), model: 'catalog/model-fast',
      }))).resolves.toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'ok' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
        {
          type: 'finish',
          reason: { kind: 'stop' },
          replayState: {
            kind: 'openai-codex-native.responses-replay',
            version: 1,
            provider: NATIVE_CODEX_PROVIDER,
            model: 'catalog/model-fast',
            items: [{ type: 'message', blocks: [0] }],
          },
        },
      ])
      expect(responsesBody).toMatchObject({ model: 'catalog/model', service_tier: 'priority' })
      expect(responsesHeaders?.get('x-codex-routing-hint'))
        .toBe('model=catalog/model;tier=priority')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      await authFiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
    await vi.waitFor(() => { expect(ctx.llm.listProviders()).toEqual([]) })
  })

  it('keeps native and existing pi-ai route names registered together', () => {
    const disposeExisting = ctx.llm.registerAdapter(
      [PI_CODEX_PROVIDER],
      new ExistingCodexAdapter(),
    )
    const disposeNative = ctx.llm.registerAdapter(
      [NATIVE_CODEX_PROVIDER],
      new NativeCodexAdapter(),
    )

    expect(ctx.llm.listProviders()).toEqual([
      { id: PI_CODEX_PROVIDER, name: 'Existing pi-ai Codex route' },
      { id: NATIVE_CODEX_PROVIDER, name: 'OpenAI Codex (Native, Experimental)' },
    ])

    disposeNative()
    disposeExisting()
  })

  it('rejects taking the existing openai-codex route atomically', () => {
    const disposeExisting = ctx.llm.registerAdapter(
      [PI_CODEX_PROVIDER],
      new ExistingCodexAdapter(),
    )

    expect(() => ctx.llm.registerAdapter(
      [PI_CODEX_PROVIDER],
      new NativeCodexAdapter(),
    )).toThrowError(expect.objectContaining({ code: 'DUPLICATE_ADAPTER' }))
    expect(ctx.llm.listProviders()).toEqual([
      { id: PI_CODEX_PROVIDER, name: 'Existing pi-ai Codex route' },
    ])

    disposeExisting()
  })

  it('disposes the native registration without disturbing the existing route', async () => {
    const disposeExisting = ctx.llm.registerAdapter(
      [PI_CODEX_PROVIDER],
      new ExistingCodexAdapter(),
    )
    const disposeNative = ctx.llm.registerAdapter(
      [NATIVE_CODEX_PROVIDER],
      new NativeCodexAdapter(),
    )

    disposeNative()
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toEqual([
        { id: PI_CODEX_PROVIDER, name: 'Existing pi-ai Codex route' },
      ])
    })

    disposeExisting()
  })

  it('delegates through the real runtime with outer retries disabled', async () => {
    const seen: GenerateOptions[] = []
    const transport = {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        seen.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const adapter = new NativeCodexAdapter(undefined, transport)
    const disposeNative = ctx.llm.registerAdapter([NATIVE_CODEX_PROVIDER], adapter)

    expect(await collect(ctx.llm.stream(request()))).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(seen).toHaveLength(1)
    expect(adapter.providerRetryPolicy(NATIVE_CODEX_PROVIDER)).toMatchObject({
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: [],
    })

    disposeNative()
  })

  it('exposes replay state only when the same adapter instance owns history and target', async () => {
    class SeeingAdapter extends LlmAdapter {
      readonly seen: unknown[] = []
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const source = options.messages[0]?.source
        this.seen.push(source?.kind === 'model' ? source.replayState : undefined)
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const shared = new SeeingAdapter()
    const foreign = new SeeingAdapter()
    const disposeShared = ctx.llm.registerAdapter(['source-route', 'same-target'], shared)
    const disposeForeign = ctx.llm.registerAdapter(['foreign-target'], foreign)
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'durable' }],
      source: {
        kind: 'model', provider: 'source-route', model: 'model',
        replayState: { opaque: 'same-adapter-only' },
      },
    } as unknown as GenerateOptions['messages'][number]

    await collect(ctx.llm.stream({
      provider: 'same-target', model: 'model', messages: [message],
    }))
    await collect(ctx.llm.stream({
      provider: 'foreign-target', model: 'model', messages: [message],
    }))
    expect(shared.seen).toEqual([{ opaque: 'same-adapter-only' }])
    expect(foreign.seen).toEqual([undefined])

    disposeForeign()
    disposeShared()
  })

  it('throws runtime LlmError instances for unconfigured and pre-aborted calls', async () => {
    const adapter = new NativeCodexAdapter()
    const notConfigured = await collect(adapter.stream(request())).catch((error: unknown) => error)
    expect(notConfigured).toBeInstanceOf(LlmError)
    expect(notConfigured).toMatchObject({ code: 'NATIVE_TRANSPORT_NOT_CONFIGURED' })

    const abort = new AbortController()
    abort.abort()
    const resolveAborted = await adapter.resolveModel(
      NATIVE_CODEX_PROVIDER,
      'exact/model-id',
      abort.signal,
    ).catch((error: unknown) => error)
    const streamAborted = await collect(adapter.stream(request(
      NATIVE_CODEX_PROVIDER,
      abort.signal,
    ))).catch((error: unknown) => error)

    expect(resolveAborted).toBeInstanceOf(LlmError)
    expect(resolveAborted).toMatchObject({ code: 'ABORTED' })
    expect(streamAborted).toBeInstanceOf(LlmError)
    expect(streamAborted).toMatchObject({ code: 'ABORTED' })
  })
})
