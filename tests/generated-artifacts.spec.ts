import { describe, expect, it } from 'vitest'
import OpenAICodexAuth from '../lib/index.js'
import { NativeCodexCatalog } from '../lib/catalog.js'
import {
  NATIVE_CODEX_PROVIDER,
  NativeCodexAdapter,
} from '../lib/native-adapter.js'

describe('generated package artifacts', () => {
  it('imports the package graph and contains the M2 model mapper', async () => {
    expect(OpenAICodexAuth).toBeTypeOf('function')
    expect(NativeCodexCatalog).toBeTypeOf('function')
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
})
