import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createMessage, createUserMessage, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, type EpochHeader, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate'
import CodexTokenMeter from '../src/token-meter.ts'
import { CODEX_PROVIDER, NATIVE_CODEX_PROVIDER, NativeCodexAdapter, registerNativeCodexAdapter } from '../src/native-adapter.ts'
import { createNativeCodexReplayState } from '../src/replay.ts'

const MODEL = 'model-a'
const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })
class ForeignAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}
function harness(native = true) {
  const ctx = new Context()
  roots.push(ctx)
  new SessionProjectionRegistry(ctx)
  new LlmRuntime(ctx)
  if (native) registerNativeCodexAdapter(ctx, [CODEX_PROVIDER, NATIVE_CODEX_PROVIDER], new NativeCodexAdapter())
  ctx.llm.registerAdapter(['foreign'], new ForeignAdapter())
  const meter = new CodexTokenMeter(ctx)
  const pressure = (session: Session) => ctx.sessionProjections.snapshot(session).values.contextPressure!
  return { ctx, meter, pressure }
}
function envelope(provider = CODEX_PROVIDER, model = MODEL): EpochHeader { return { config: { provider, model } } }
function publish(ctx: Context, session: Session, event: SessionEvent) { ctx.emit('session/event', session, event) }
function route(ctx: Context, session: Session, provider = CODEX_PROVIDER, model = MODEL, window = 10000) {
  publish(ctx, session, session.append('request/header', { header: envelope(provider, model), reason: 'change' }))
  publish(ctx, session, session.append('request/context', { provider, model, contextWindow: window }))
}
function call(ctx: Context, session: Session, turn: number, usage: TokenUsage | undefined, provider = CODEX_PROVIDER, replay = true) {
  session.append('turn/start', { turn })
  const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  publish(ctx, session, user)
  session.append('step/start', { turn, step: 1 })
  route(ctx, session, provider, MODEL, provider === 'foreign' ? 8000 : 10000)
  const block = { type: 'text' as const, text: 'reply' }
  const replayState = replay ? { response: createNativeCodexReplayState(provider, MODEL, [
    { type: 'reasoning', blocks: [], encryptedContent: 'YQ==' }, { type: 'message', blocks: [0] },
  ]) } : undefined
  const message = createMessage({ role: 'assistant', content: [block], source: {
    kind: 'model', provider, model: MODEL, ...replayState === undefined ? {} : { replayState },
  } })
  const finish: StreamChunk = { type: 'finish', reason: { kind: replay ? 'stop' : 'max-tokens' }, ...replayState === undefined ? {} : { replayState } }
  const event = session.append('assistant/message', {
    turn, step: 1, message, ...usage === undefined ? {} : { usage },
    stream: [
      { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block } },
      ...usage === undefined ? [] : [{ type: 'chunk' as const, time: 0, chunk: { type: 'usage' as const, usage } }],
      { type: 'chunk', time: 0, chunk: finish },
    ],
  }, { surfaceOp: 'append' })
  publish(ctx, session, event)
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { user, event, message }
}
function replace(ctx: Context, session: Session, start: SessionSeq, end: SessionSeq, text: string) {
  const current = session.surface.nodes
  const nodes = current.slice(current.indexOf(start), current.indexOf(end) + 1)
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const event = session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [...nodes].sort((a, b) => a - b),
  })
  publish(ctx, session, event)
  return event
}
const usage = (turn = 1): TokenUsage => ({ inputTokens: 200 + (turn - 1) * 1000, outputTokens: 1001, reasoningTokens: 1000 })

describe('Codex UI pressure projection', () => {
  it('registers one corrected pressure unit through real Cordis tracing and preserves measured input', () => {
    const { ctx, pressure } = harness()
    const session = Session.create(SessionId('native'))
    call(ctx, session, 1, usage())
    expect(pressure(session)).toEqual({ pressureTokens: 200, projectedTokens: 1210, contextWindow: 10000 })
    call(ctx, session, 2, usage(2))
    expect(pressure(session)).toEqual({ pressureTokens: 1200, projectedTokens: 2210, contextWindow: 10000 })
    expect(ctx.sessionProjections.checkpoint(session).contextPressure!.ver).toBe(6)
    expect(ctx.sessionProjections.snapshot(session).values).toHaveProperty('tokenUsage')
    expect(ctx.sessionProjections.snapshot(session).values).toHaveProperty('contextBreakdown')
  })

  it('isolates alternating Native and ordinary conversations and keeps ordinary pricing', () => {
    const { ctx, pressure } = harness()
    const a = Session.create(SessionId('a'))
    const b = Session.create(SessionId('b'))
    call(ctx, a, 1, usage())
    call(ctx, b, 1, { inputTokens: 500, outputTokens: 10 }, 'foreign', false)
    const originalB = pressure(b)
    expect(originalB).toEqual({ pressureTokens: 500, projectedTokens: 510, contextWindow: 8000 })
    call(ctx, a, 2, usage(2))
    expect(pressure(a).projectedTokens).toBe(2210)
    expect(pressure(b)).toEqual(originalB)
    call(ctx, b, 2, { inputTokens: 600, outputTokens: 10 }, 'foreign', false)
    expect(pressure(b).projectedTokens).toBe(610)
    expect(pressure(a).projectedTokens).toBe(2210)
  })

  it('reprices a dialogue switch and withholds the previous model window until matching context arrives', () => {
    const { ctx, pressure } = harness()
    const session = Session.create(SessionId('switch'))
    call(ctx, session, 1, usage())
    publish(ctx, session, session.append('request/header', { header: envelope('foreign', 'model-b'), reason: 'change' }))
    expect(pressure(session)).toEqual({ pressureTokens: 200, projectedTokens: 19 })
    publish(ctx, session, session.append('request/context', { provider: 'foreign', model: 'model-b', contextWindow: 8000 }))
    expect(pressure(session).contextWindow).toBe(8000)
    publish(ctx, session, session.append('request/header', { header: envelope(), reason: 'change' }))
    expect(pressure(session)).toEqual({ pressureTokens: 200, projectedTokens: 1210 })
    publish(ctx, session, session.append('request/context', { provider: CODEX_PROVIDER, model: MODEL, contextWindow: 10000 }))
    expect(pressure(session).contextWindow).toBe(10000)
    route(ctx, session, CODEX_PROVIDER, 'model-c', 20000)
    expect(pressure(session)).toEqual({ pressureTokens: 200, projectedTokens: 1019, contextWindow: 20000 })
  })

  it('invalidates an ordinary-model sample on a route change without affecting another dialogue', () => {
    const { ctx, pressure } = harness()
    const native = Session.create(SessionId('native-other'))
    const ordinary = Session.create(SessionId('ordinary-switch'))
    call(ctx, native, 1, usage())
    call(ctx, ordinary, 1, { inputTokens: 500, outputTokens: 10 }, 'foreign', false)
    publish(ctx, ordinary, ordinary.append('request/header', { header: envelope('foreign', 'model-b'), reason: 'change' }))
    expect(pressure(ordinary)).toEqual({ pressureTokens: 500, projectedTokens: 19 })
    publish(ctx, ordinary, ordinary.append('request/context', { provider: 'foreign', model: 'model-b', contextWindow: 20000 }))
    expect(pressure(ordinary).contextWindow).toBe(20000)
    expect(pressure(native).projectedTokens).toBe(1210)
  })

  it('handles a Native max-token sample with no replay metadata, including switching away', () => {
    const { ctx, pressure } = harness()
    const session = Session.create(SessionId('no-replay'))
    call(ctx, session, 1, usage(), CODEX_PROVIDER, false)
    expect(pressure(session).projectedTokens).toBe(210)
    route(ctx, session, 'foreign', 'model-b', 8000)
    expect(pressure(session)).toEqual({ pressureTokens: 200, projectedTokens: 19, contextWindow: 8000 })
  })

  it('uses input from an attempt without replaying its incomplete output reasoning', () => {
    const { ctx, pressure } = harness()
    const session = Session.create(SessionId('attempt'))
    call(ctx, session, 1, usage())
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    publish(ctx, session, session.append('assistant/attempt', {
      turn: 2, step: 1,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 1200, outputTokens: 9000, reasoningTokens: 9000 } } }],
    }))
    expect(pressure(session)).toEqual({ pressureTokens: 1200, projectedTokens: 1200, contextWindow: 10000 })
    route(ctx, session, 'foreign', 'model-b', 8000)
    expect(pressure(session).projectedTokens).toBe(19)
  })

  it('preserves explicit zero and estimates hidden replay when no usage is available', () => {
    const { ctx, pressure } = harness()
    const zero = Session.create(SessionId('zero'))
    call(ctx, zero, 1, { inputTokens: 200, outputTokens: 10, reasoningTokens: 0 })
    expect(pressure(zero).projectedTokens).toBe(210)
    const absent = Session.create(SessionId('absent'))
    call(ctx, absent, 1, undefined)
    expect(pressure(absent)).toEqual({ projectedTokens: 20, contextWindow: 10000 })
  })

  it('estimates the complete surface when the reported input is below its hidden anchor', () => {
    const { ctx, pressure } = harness()
    const session = Session.create(SessionId('lower-bound'))
    call(ctx, session, 1, usage())
    call(ctx, session, 2, { inputTokens: 1, outputTokens: 1001, reasoningTokens: 1000 })
    expect(pressure(session)).toEqual({ pressureTokens: 1, projectedTokens: 2038, contextWindow: 10000 })
  })

  it('deducts removed hidden nodes through successive nonmonotonic positional replacements', () => {
    const { ctx, pressure } = harness()
    const session = Session.create(SessionId('replace'))
    const a = call(ctx, session, 1, usage())
    const b = call(ctx, session, 2, usage(2))
    const before = pressure(session)
    const summary = replace(ctx, session, a.user.seq, a.event.seq, 'summary')
    expect(summary.seq).toBeGreaterThan(b.event.seq)
    expect(pressure(session).projectedTokens).toBe(before.projectedTokens! - 1000)
    replace(ctx, session, summary.seq, b.event.seq, 'smaller summary')
    expect(pressure(session).projectedTokens).toBe(before.projectedTokens! - 2000)
  })

  it('reuses equivalent reordered configurations instead of losing a valid sample', () => {
    const { ctx, pressure } = harness()
    const session = Session.create(SessionId('equal-header'))
    call(ctx, session, 1, usage())
    publish(ctx, session, session.append('request/header', { header: { config: { model: MODEL, provider: CODEX_PROVIDER } }, reason: 'change' }))
    expect(pressure(session).projectedTokens).toBe(1210)
  })

  it('restores JSON history, checkpoint views and tail replay consistently, ignoring a stale derived view', () => {
    const { ctx, pressure } = harness()
    const session = Session.create(SessionId('restore'))
    call(ctx, session, 1, usage())
    const expected = pressure(session)
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const row = checkpoint.contextPressure!
    const altered = JSON.parse(JSON.stringify(checkpoint))
    altered.contextPressure.val.codex.view = { projectedTokens: 0 }
    expect(ctx.sessionProjections.viewCheckpoint(altered).contextPressure).toEqual(expected)
    const floor = ctx.sessionProjections.restoreFloor(checkpoint)!
    const restored = ctx.sessionProjections.restore(checkpoint, session.snapshotEvents().slice(floor), floor, session.header, session.inheritedEventCount)
    expect(restored.snapshot.values.contextPressure).toEqual(expected)
    expect(row.ver).toBe(6)
    const restart = Session.create(SessionId('restarted'), JSON.parse(JSON.stringify(session.snapshotEvents())))
    expect(pressure(restart)).toEqual(expected)
  })

  it('invalidates old native samples and cold views when the owner disappears', async () => {
    const { ctx, pressure } = harness(false)
    const fiber = await ctx.plugin({ apply(scope: Context) {
      registerNativeCodexAdapter(scope, [CODEX_PROVIDER], new NativeCodexAdapter())
    } })
    const session = Session.create(SessionId('owner-gone'))
    call(ctx, session, 1, usage())
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    expect(pressure(session).projectedTokens).toBe(1210)
    await fiber.dispose()
    ctx.llm.registerAdapter([CODEX_PROVIDER], new ForeignAdapter())
    expect(pressure(session).projectedTokens).toBe(19)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).contextPressure!.projectedTokens).toBe(19)
    const floor = ctx.sessionProjections.restoreFloor(checkpoint)!
    expect(ctx.sessionProjections.restore(checkpoint, session.snapshotEvents().slice(floor), floor, session.header, session.inheritedEventCount).snapshot.values.contextPressure!.projectedTokens).toBe(19)
  })

  it('re-estimates cross-alias samples rather than assuming their historical owner grouping', async () => {
    const { ctx, pressure } = harness(false)
    let fiber = await ctx.plugin({ apply(scope: Context) {
      registerNativeCodexAdapter(scope, [CODEX_PROVIDER, NATIVE_CODEX_PROVIDER], new NativeCodexAdapter())
    } })
    const session = Session.create(SessionId('groups'))
    call(ctx, session, 1, usage(), NATIVE_CODEX_PROVIDER)
    call(ctx, session, 2, usage(2))
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    expect(pressure(session).projectedTokens).toBe(2038)
    await fiber.dispose()
    fiber = await ctx.plugin({ apply(scope: Context) {
      registerNativeCodexAdapter(scope, [CODEX_PROVIDER], new NativeCodexAdapter())
      registerNativeCodexAdapter(scope, [NATIVE_CODEX_PROVIDER], new NativeCodexAdapter())
    } })
    expect(pressure(session).projectedTokens).toBe(1038)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).contextPressure!.projectedTokens).toBe(1038)
    await fiber.dispose()
    fiber = await ctx.plugin({ apply(scope: Context) {
      registerNativeCodexAdapter(scope, [CODEX_PROVIDER, NATIVE_CODEX_PROVIDER], new NativeCodexAdapter())
    } })
    expect(pressure(session).projectedTokens).toBe(2038)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).contextPressure!.projectedTokens).toBe(2038)
  })

  it('suppresses unchanged-wire updates while driving a real session change feed', () => {
    const { ctx, pressure } = harness()
    const session = Session.create(SessionId('feed'))
    const changes: Array<SessionProjectionMap['contextPressure']> = []
    ctx.sessionProjections.onChanged((changed, key, value) => {
      if (changed === session && key === 'contextPressure') changes.push(value as SessionProjectionMap['contextPressure'])
    })
    call(ctx, session, 1, usage())
    expect(changes.at(-1)!.projectedTokens).toBe(1210)
    const count = changes.length
    const unrelated = session.append('turn/start', { turn: 2 })
    publish(ctx, session, unrelated)
    publish(ctx, session, session.append('request/header', { header: envelope(), reason: 'series' }))
    publish(ctx, session, session.append('request/context', { provider: CODEX_PROVIDER, model: MODEL, contextWindow: 10000 }))
    expect(changes.length).toBe(count)
    expect(pressure(session).projectedTokens).toBe(1210)
  })

  it('keeps ordinary long conversations sparse when no native replay is present', () => {
    const { ctx } = harness()
    const session = Session.create(SessionId('ordinary-size'))
    for (let turn = 1; turn <= 30; turn++) call(ctx, session, turn, { inputTokens: 500, outputTokens: 10 }, 'foreign', false)
    const state = ctx.sessionProjections.checkpoint(session).contextPressure!.val as { codex: { nodes: unknown[]; positions: unknown[] } }
    expect(state.codex.nodes).toEqual([])
    expect(state.codex.positions).toEqual([])
  })
})
