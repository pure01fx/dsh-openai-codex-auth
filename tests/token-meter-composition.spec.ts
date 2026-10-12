import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import LlmRuntime, { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as authModule from '../lib/index.js'
import * as meterModule from '@pure01fx/dsh-openai-codex-auth/token-meter'
import * as baseMeterModule from '@deepseek-ai/dsh-token-meter'
import { createNativeCodexReplayState } from '../lib/replay.js'

class FixtureLoader extends Loader {
  override import(name: string, stack?: () => string[]) {
    if (name === '@pure01fx/dsh-openai-codex-auth') return authModule
    if (name === '@pure01fx/dsh-openai-codex-auth/token-meter') return meterModule
    if (name === '@deepseek-ai/dsh-token-meter') return baseMeterModule
    return super.import(name, stack)
  }
}

describe('published token-meter composition', () => {
  it('boots the shipped patch with one active meter and native replay pricing, then releases both', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-meter-composition-'))
    const ctx = new Context()
    const loaderFiber = await ctx.plugin(FixtureLoader, { baseUrl: new URL('../', import.meta.url).href })
    new LlmRuntime(ctx)
    new SessionProjectionRegistry(ctx)
    ctx.provide('credentials', {
      async resolve() { return undefined },
      async describe() { return { configured: false, writable: false } },
    })
    ctx.provide('webRuntime', { lanAddresses: [], trustedHosts: [] })
    const routes = new Set<string>()
    ctx.provide('webServer', {
      port: 3080, host: '127.0.0.1',
      register(route: { path: string }) {
        if (routes.has(route.path)) throw new Error('duplicate HTTP route')
        routes.add(route.path)
        return () => { routes.delete(route.path) }
      },
    })
    try {
      const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
      const patches = load(patchText, { schema: entryListSchema }) as PatchOptions[]
      const warnings: string[] = []
      const original: EntryOptions[] = [{ id: 'token-meter', name: '@deepseek-ai/dsh-token-meter' }]
      const entries = applyEntryPatches(original, patches, message => warnings.push(message))
      entries.find(entry => entry.id === 'openai-codex-auth')!.config = {
        dshHome: home, cloudTools: { enabled: false }, nativeWebSocket: false,
      }
      expect(warnings).toEqual([])
      expect(original[0]!.disabled).toBeUndefined()
      await ctx.loader.root.update(entries)
      await ctx.loader.await()
      expect(ctx.loader.resolve('token-meter').fiber).toBeUndefined()
      expect(ctx.loader.resolve('codex-token-meter').fiber?.state).toBe(2)
      expect(ctx.loader.resolve('openai-codex-auth').fiber?.state).toBe(2)
      const meter = ctx.get('tokenMeter')!
      expect(meter).toBeInstanceOf(meterModule.CodexTokenMeter)
      const session = Session.create(SessionId('composed'))
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('request/header', { header: { config: { provider: 'openai-codex', model: 'fixture' } }, reason: 'initial' })
      const replayState = { response: createNativeCodexReplayState('openai-codex', 'fixture', [
        { type: 'reasoning', blocks: [], encryptedContent: 'YQ==' },
        { type: 'message', blocks: [0] },
      ]) }
      const block = { type: 'text' as const, text: 'reply' }
      const usage = { inputTokens: 200, outputTokens: 1001, reasoningTokens: 1000 }
      const assistant = session.append('assistant/message', {
        turn: 1, step: 1, usage,
        message: createMessage({ role: 'assistant', content: [block], source: { kind: 'model', provider: 'openai-codex', model: 'fixture', replayState } }),
        stream: [
          { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block } },
          { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState } },
        ],
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      const measurement = meter.measure(session)
      expect(measurement.nodes.find(node => node.seq === assistant.seq)!.tokens).toBeGreaterThan(1000)
      expect(measurement.totalTokens).toBe(1201)
      expect(measurement.surfaceDeltaTokens).toBe(0)
      expect(ctx.sessionProjections.snapshot(session).values).toHaveProperty('contextPressure')
      const frozen = measurement
      await ctx.loader.root.stop()
      await ctx.loader.await()
      expect(ctx.get('tokenMeter')).toBeUndefined()
      expect(ctx.get('openaiCodexAuth')).toBeUndefined()
      expect(routes.size).toBe(0)
      expect(frozen.totalTokens).toBe(1201)
    } finally {
      await ctx.loader.root.stop()
      await ctx.loader.await()
      await loaderFiber.dispose()
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})
