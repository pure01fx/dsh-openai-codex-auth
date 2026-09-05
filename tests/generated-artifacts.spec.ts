import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import OpenAICodexAuth from '../lib/index.js'
import { NativeCodexCatalog } from '../lib/catalog.js'
import { NativeCodexHttpTransport } from '../lib/native-http.js'
import { NativeCodexWebSocketTransport } from '../lib/native-websocket.js'
import { codexRequestBody } from '../lib/responses.js'
import { parseSse } from '../lib/sse.js'
import { createNativeCodexReplayState, replayAssistantInput } from '../lib/replay.js'
import { parseCodexRateLimitEvent } from '../lib/rate-limits.js'
import { parseCodexResponseUsageMetadata } from '../lib/response-usage.js'
import { mergeDirectUsage } from '../lib/usage.js'
import {
  CODEX_CLIENT_VERSION,
  TRACKED_CODEX_COMMIT,
} from '../lib/upstream.js'
import {
  NATIVE_CODEX_PROVIDER,
  NativeCodexAdapter,
} from '../lib/native-adapter.js'

describe('generated package artifacts', () => {
  it('imports the package graph and contains the M2 model mapper', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      files: string[]
    }
    expect(manifest.files).toEqual(expect.arrayContaining([
      'lib/rate-limits.js', 'lib/rate-limits.d.ts',
      'lib/response-usage.js', 'lib/response-usage.d.ts',
      'lib/upstream.js', 'lib/upstream.d.ts',
      'lib/usage.js', 'lib/usage.d.ts',
    ]))
    expect(OpenAICodexAuth).toBeTypeOf('function')
    expect(NativeCodexCatalog).toBeTypeOf('function')
    expect(NativeCodexHttpTransport).toBeTypeOf('function')
    expect(NativeCodexWebSocketTransport).toBeTypeOf('function')
    expect(codexRequestBody).toBeTypeOf('function')
    expect(parseSse).toBeTypeOf('function')
    expect(createNativeCodexReplayState).toBeTypeOf('function')
    expect(replayAssistantInput).toBeTypeOf('function')
    expect(parseCodexRateLimitEvent).toBeTypeOf('function')
    expect(parseCodexResponseUsageMetadata).toBeTypeOf('function')
    expect(mergeDirectUsage).toBeTypeOf('function')
    expect(TRACKED_CODEX_COMMIT).toMatch(/^[0-9a-f]{40}$/u)
    expect(CODEX_CLIENT_VERSION).toBe('0.153.4')
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

  it('runs generated Fast routing and restart-safe replay semantics', async () => {
    const seen: Array<{ model: string; tier?: string }> = []
    const model = {
      slug: 'generated/fast', displayName: 'Generated Fast',
      supportedReasoningLevels: [], visibility: 'list' as const, supportedInApi: false,
      priority: 0, additionalSpeedTiers: ['fast'], serviceTiers: [],
      inputModalities: ['text'],
    }
    const adapter = new NativeCodexAdapter({
      list: async () => [model],
      listWithAuthority: async () => ({ models: [model], authorityHash: 'authority-a' }),
      etag: () => undefined,
    }, {
      async *stream(options, mode) {
        seen.push({
          model: options.model,
          ...(mode?.serviceTier === undefined ? {} : { tier: mode.serviceTier }),
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    for await (const _chunk of adapter.stream({
      provider: NATIVE_CODEX_PROVIDER,
      model: 'generated/fast-fast',
      messages: [],
    })) { /* consume */ }
    expect(seen).toEqual([{ model: 'generated/fast', tier: 'priority' }])

    const state = createNativeCodexReplayState(NATIVE_CODEX_PROVIDER, 'generated/fast-fast', [
      { type: 'message', blocks: [0] },
    ])
    expect(replayAssistantInput([{ type: 'text', text: 'durable' }], {
      provider: NATIVE_CODEX_PROVIDER,
      model: 'generated/fast-fast',
      replayState: JSON.parse(JSON.stringify(state)),
    })).toEqual([{
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'durable' }],
    }])
  })

  it('matches every committed generated module to a fresh TypeScript build', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-codex-build-'))
    try {
      await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/tsc'), [
        '--outDir', temporary,
        '--declarationDir', temporary,
      ])
      const modules = [
        'catalog', 'endpoint', 'index', 'native-adapter', 'native-http',
        'native-websocket', 'native-websocket-session', 'native-websocket-socket',
        'rate-limits', 'replay', 'response-usage', 'responses', 'sse', 'upstream', 'usage',
      ]
      for (const module of modules) {
        for (const extension of ['js', 'd.ts']) {
          const name = `${module}.${extension}`
          const [fresh, committed] = await Promise.all([
            readFile(join(temporary, name), 'utf8'),
            readFile(join(process.cwd(), 'lib', name), 'utf8'),
          ])
          expect(fresh).toBe(committed)
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
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
