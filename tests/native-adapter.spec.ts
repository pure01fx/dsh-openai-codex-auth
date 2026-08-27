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
import {
  NATIVE_CODEX_PROVIDER,
  NativeCodexAdapter,
} from '../src/native-adapter.ts'

const PI_CODEX_PROVIDER = 'openai-codex'

class RegistrationCredentials {
  async resolve() { return undefined }
  async describe() { return { configured: false, writable: true } }
  async set() {}
  async unset() {}
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

describe('NativeCodexAdapter M1 skeleton', () => {
  let ctx: Context
  let runtimeFiber: Fiber

  beforeEach(async () => {
    ctx = new Context()
    runtimeFiber = ctx.plugin(LlmRuntime)
    await runtimeFiber
  })

  afterEach(async () => {
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

  it('registers the experimental route through the opt-in auth plugin config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openai-codex-native-registration-'))
    ctx.provide('credentials', new RegistrationCredentials() as never)
    ctx.provide('webServer', new RegistrationWebServer() as never)
    ctx.provide('webRuntime', { lanAddresses: [], trustedHosts: [] })
    const authFiber = await ctx.plugin(OpenAICodexAuth, { dshHome: home, nativeAdapter: true })
    try {
      await vi.waitFor(() => {
        expect(ctx.llm.listProviders()).toContainEqual({
          id: NATIVE_CODEX_PROVIDER,
          name: 'OpenAI Codex (Native, Experimental)',
        })
      })
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

  it('normalizes skeleton dispatch into a terminal not-ready failure', async () => {
    const disposeNative = ctx.llm.registerAdapter(
      [NATIVE_CODEX_PROVIDER],
      new NativeCodexAdapter(),
    )

    expect(await collect(ctx.llm.stream(request()))).toEqual([
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'NATIVE_TRANSPORT_NOT_READY',
            message: 'native Codex transport is not implemented in M1',
          },
        },
      },
    ])

    disposeNative()
  })

  it('throws runtime LlmError instances for not-ready and pre-aborted calls', async () => {
    const adapter = new NativeCodexAdapter()
    const notReady = await collect(adapter.stream(request())).catch((error: unknown) => error)
    expect(notReady).toBeInstanceOf(LlmError)
    expect(notReady).toMatchObject({ code: 'NATIVE_TRANSPORT_NOT_READY' })

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
