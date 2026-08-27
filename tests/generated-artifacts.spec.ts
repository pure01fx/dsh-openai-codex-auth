import { describe, expect, it } from 'vitest'
import OpenAICodexAuth from '../lib/index.js'
import { NativeCodexCatalog } from '../lib/catalog.js'
import { NativeCodexHttpTransport } from '../lib/native-http.js'
import { codexRequestBody } from '../lib/responses.js'
import { parseSse } from '../lib/sse.js'
import {
  NATIVE_CODEX_PROVIDER,
  NativeCodexAdapter,
} from '../lib/native-adapter.js'

describe('generated package artifacts', () => {
  it('imports the package graph and contains the M2 model mapper', async () => {
    expect(OpenAICodexAuth).toBeTypeOf('function')
    expect(NativeCodexCatalog).toBeTypeOf('function')
    expect(NativeCodexHttpTransport).toBeTypeOf('function')
    expect(codexRequestBody).toBeTypeOf('function')
    expect(parseSse).toBeTypeOf('function')
    const adapter = new NativeCodexAdapter({
      etag: () => undefined,
      list: async () => [{
        slug: 'generated/model',
        displayName: 'Generated Model',
        supportedReasoningLevels: [],
        visibility: 'list',
        supportedInApi: true,
        priority: 0,
        additionalSpeedTiers: [],
        serviceTiers: [],
        inputModalities: ['text'],
      }],
    })

    await expect(adapter.listModels(NATIVE_CODEX_PROVIDER)).resolves.toEqual([{
      provider: NATIVE_CODEX_PROVIDER,
      id: 'generated/model',
      name: 'Generated Model',
      inputModalities: ['text'],
    }])
  })

  it('runs generated M3 transport cancellation semantics', async () => {
    let fetched!: () => void
    const ready = new Promise<void>((resolve) => { fetched = resolve })
    const body = new ReadableStream<Uint8Array>()
    const controller = new AbortController()
    const transport = new NativeCodexHttpTransport({
      resolveCredential: async () => ({ accessToken: 'synthetic', accountId: 'synthetic' }),
      fetch: (async () => {
        fetched()
        return new Response(body, { status: 400 })
      }) as typeof fetch,
      maxTransientRetries: 0,
    })
    const pending = (async () => {
      for await (const _chunk of transport.stream({
        provider: NATIVE_CODEX_PROVIDER,
        model: 'generated/model',
        messages: [],
        signal: controller.signal,
      })) { /* no chunks expected */ }
    })()
    await ready
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
