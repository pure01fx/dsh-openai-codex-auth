import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter, createMessage, createUserMessage,
  type ContentBlock, type Message, type StreamChunk, type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, canonicalHeader, type SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { estimateMessage, estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CODEX_PROVIDER, NATIVE_CODEX_PROVIDER, NativeCodexAdapter,
  registerNativeCodexAdapter, canReplayNativeCodex,
} from '../src/native-adapter.ts'
import { createNativeCodexReplayState, estimateNativeCodexReplayTokens } from '../src/replay.ts'
import CodexTokenMeter from '../src/token-meter.ts'
import { mapResponsesUsage } from '../src/responses.ts'

const MODEL = 'fixture-model'
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

class FixtureAdapter extends NativeCodexAdapter {
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 5000 } }
  }
}
class ForeignAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  new SessionProjectionRegistry(ctx)
  new LlmRuntime(ctx)
  registerNativeCodexAdapter(ctx, [CODEX_PROVIDER, NATIVE_CODEX_PROVIDER], new FixtureAdapter())
  ctx.llm.registerAdapter(['foreign'], new ForeignAdapter())
  const meter = new CodexTokenMeter(ctx)
  return { ctx, meter, session: Session.create(SessionId('hidden-replay')) }
}
function header(provider = CODEX_PROVIDER, model = MODEL) {
  return canonicalHeader({ config: { provider, model } })
}
function source(provider = CODEX_PROVIDER) {
  return { provider, model: MODEL, replayState: { response: createNativeCodexReplayState(provider, MODEL, [
    { type: 'reasoning', blocks: [], encryptedContent: Buffer.from('first').toString('base64') },
    { type: 'reasoning', blocks: [], encryptedContent: Buffer.from('second').toString('base64') },
    { type: 'message', blocks: [0] },
  ]) } }
}
function appendCall(session: Session, turn: number, usage?: TokenUsage, rewrite = false, provider = CODEX_PROVIDER) {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('request/header', { header: header(provider), reason: 'initial' })
  const attribution = source(provider)
  const content: ContentBlock[] = [{ type: 'text', text: 'reply' }]
  const stream: StreamChunk[] = [
    { type: 'block-end', index: 0, block: content[0]! },
    ...usage === undefined ? [] : [{ type: 'usage' as const, usage }],
    { type: 'finish', reason: { kind: 'stop' }, replayState: attribution.replayState },
  ]
  const message = createMessage({ role: 'assistant', content, source: {
    kind: 'model', ...rewrite ? { provider, model: MODEL } : attribution,
  } })
  const event = session.append('assistant/message', {
    turn, step: 1, stream: stream.map(chunk => ({ type: 'chunk' as const, time: 0, chunk })), message, ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { event, message }
}
function replace(session: Session, startSeq: SessionSeq, endSeq: SessionSeq, text: string) {
  const from = session.eventAt(startSeq)!
  const to = session.eventAt(endSeq)!
  const nodes = session.surface.nodes
  const cited = nodes.slice(nodes.indexOf(startSeq), nodes.indexOf(endSeq) + 1).sort((a, b) => a - b)
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), {
    sourceEventSeqs: cited,
    surfaceOp: { op: 'replace', startSeq: from.seq, endSeq: to.seq },
  })
}

describe('native Codex token meter', () => {
  it('charges response reasoning once across encrypted items and never adds it twice to provider usage', () => {
    const { meter, session } = harness()
    const first = appendCall(session, 1, { inputTokens: 200, outputTokens: 1001, reasoningTokens: 1000 })
    const second = appendCall(session, 2, { inputTokens: 1200, outputTokens: 1001, reasoningTokens: 1000 })
    const measured = meter.measure(session)
    expect(measured.baseline).toMatchObject({ kind: 'usage', tokens: 2201 })
    expect(measured.totalTokens).toBe(2201)
    expect(measured.surfaceDeltaTokens).toBe(0)
    for (const { event, message } of [first, second]) {
      const node = measured.nodes.find(node => node.seq === event.seq)!
      expect(node.tokens).toBe(estimateMessage(message) + 1000)
      expect(node.heuristicTokens).toBe(estimateMessage(message))
    }
    expect(measured.surfaceTokens).toBe(measured.nodes.reduce((total, node) => total + node.tokens, 0))
    expect(Object.isFrozen(measured)).toBe(true)
    expect(Object.isFrozen(measured.nodes[0])).toBe(true)
  })

  it('subtracts removed hidden reasoning and follows successive positional replacements', () => {
    const { meter, session } = harness()
    const first = appendCall(session, 1, { inputTokens: 200, outputTokens: 1001, reasoningTokens: 1000 })
    const second = appendCall(session, 2, { inputTokens: 1200, outputTokens: 1001, reasoningTokens: 1000 })
    const before = meter.measure(session)
    const summary = replace(session, before.nodes[0]!.seq, first.event.seq, 'summary')
    const after = meter.measure(session)
    const removed = before.nodes.slice(0, 2).reduce((n, node) => n + node.tokens, 0)
    expect(after.totalTokens).toBe(before.totalTokens - removed + after.nodes[0]!.tokens)
    expect(after.nodes[0]!.seq).toBe(summary.seq)
    expect(summary.seq).toBeGreaterThan(second.event.seq)
    const next = replace(session, summary.seq, second.event.seq, 'smaller summary')
    const final = meter.measure(session)
    expect(final.nodes.map(node => node.seq)).toEqual([next.seq])
    expect(final.surfaceTokens).toBe(final.nodes[0]!.tokens)
    expect(final.surfaceDeltaTokens).toBe(final.surfaceTokens - before.surfaceTokens)
    expect(before.totalTokens).toBe(2201)
  })

  it('uses the original stream replay when the durable assistant drops it', () => {
    const { meter, session } = harness()
    const result = appendCall(session, 1, { inputTokens: 200, outputTokens: 1001, reasoningTokens: 1000 }, true)
    const measured = meter.measure(session)
    expect(measured.nodes.at(-1)!.tokens).toBe(estimateMessage(result.message))
    expect(measured.baseline).toMatchObject({ kind: 'usage', tokens: 1201 })
    expect(measured.surfaceDeltaTokens).toBe(-1000)
    expect(measured.totalTokens).toBe(201)
  })

  it('falls back to a corrected estimate when usage is below the full anchor and reuses equality', () => {
    for (const difference of [-1, 0, 1]) {
      const { meter, session } = harness()
      const result = appendCall(session, 1, { inputTokens: 1, outputTokens: 1001, reasoningTokens: 1000 })
      const measured = meter.measure(session)
      const anchor = measured.surfaceTokens + estimateToolsTokens(header())
      const replayed = Session.create(SessionId('guard'), session.snapshotEvents().map(event => event.seq === result.event.seq && event.type === 'assistant/message'
        ? { ...event, data: { ...event.data, usage: { inputTokens: anchor + difference - 1001, outputTokens: 1001, reasoningTokens: 1000 } } }
        : event))
      const corrected = meter.measure(replayed)
      expect(corrected.baseline.kind).toBe(difference < 0 ? 'estimated' : 'usage')
      expect(corrected.totalTokens).toBe(anchor + Math.max(0, difference))
    }
  })

  it('reprices changed envelopes and supports only same-adapter aliases', () => {
    const { meter, session } = harness()
    const result = appendCall(session, 1, { inputTokens: 200, outputTokens: 1001, reasoningTokens: 1000 })
    const alias = meter.measure(session, header(NATIVE_CODEX_PROVIDER))
    expect(alias.baseline.kind).toBe('estimated')
    expect(alias.nodes.at(-1)!.tokens).toBe(estimateMessage(result.message) + 1000)
    const foreign = meter.measure(session, header('foreign'))
    expect(foreign.nodes.at(-1)!.tokens).toBe(estimateMessage(result.message))
    const newModel = meter.measure(session, header(CODEX_PROVIDER, 'new-model'))
    expect(newModel.totalTokens).toBe(newModel.surfaceTokens)
    expect(newModel.surfaceDeltaTokens).toBe(0)
  })

  it('reconstructs the same prices after JSON session restart and isolates session state', () => {
    const { meter, session } = harness()
    appendCall(session, 1, { inputTokens: 200, outputTokens: 1001, reasoningTokens: 1000 })
    const before = meter.measure(session)
    const restored = Session.create(SessionId('restored'), JSON.parse(JSON.stringify(session.snapshotEvents())))
    expect(meter.measure(restored)).toEqual({ ...before, logRevision: restored.seq })
    expect(meter.measure(Session.create(SessionId('empty'))).totalTokens).toBe(0)
  })

  it('prices no-usage history and rewritten messages with an estimated anchor', () => {
    const { meter, session } = harness()
    appendCall(session, 1)
    appendCall(session, 2, undefined, true)
    const measured = meter.measure(session)
    expect(measured.baseline.kind).toBe('estimated')
    expect(measured.nodes[1]!.tokens - measured.nodes[1]!.heuristicTokens).toBe(11)
    expect(measured.nodes[3]!.tokens).toBe(measured.nodes[3]!.heuristicTokens)
    expect(measured.totalTokens).toBe(measured.surfaceTokens)
  })

  it('does not charge a foreign source when the current request is native', () => {
    const { meter, session } = harness()
    const result = appendCall(session, 1, { inputTokens: 200, outputTokens: 1001, reasoningTokens: 1000 }, false, 'foreign')
    const measured = meter.measure(session, header())
    expect(measured.nodes.at(-1)!.tokens).toBe(estimateMessage(result.message))
    expect(measured.surfaceTokens).toBe(measured.nodes.reduce((total, node) => total + node.heuristicTokens, 0))
  })

  it('preserves an explicitly reported zero reasoning count instead of applying a fallback', () => {
    const usage = mapResponsesUsage({ input_tokens: 1, output_tokens: 42, output_tokens_details: { reasoning_tokens: 0 } })
    expect(usage.reasoningTokens).toBe(0)
    expect(estimateNativeCodexReplayTokens(source(), usage)).toBe(0)
    expect(mapResponsesUsage({ input_tokens: 1, output_tokens: 42 }).reasoningTokens).toBeUndefined()
  })

  it('uses output usage or ciphertext size when reasoning details are absent; no encrypted state costs zero', () => {
    expect(estimateNativeCodexReplayTokens(source(), { inputTokens: 1, outputTokens: 42 })).toBe(42)
    expect(estimateNativeCodexReplayTokens(source(), { inputTokens: 1, outputTokens: 42, reasoningTokens: 0 })).toBe(0)
    expect(estimateNativeCodexReplayTokens(source())).toBe(11)
    expect(estimateNativeCodexReplayTokens({ provider: CODEX_PROVIDER, model: MODEL })).toBe(0)
    expect(estimateNativeCodexReplayTokens({ provider: CODEX_PROVIDER, model: MODEL, replayState: createNativeCodexReplayState(CODEX_PROVIDER, MODEL, [
      { type: 'reasoning', blocks: [0] },
    ]) }, { inputTokens: 1, outputTokens: 42, reasoningTokens: 40 })).toBe(0)
    expect(() => estimateNativeCodexReplayTokens({ ...source(), model: 'wrong' })).toThrow('identity')
  })

  it('drops pricing ownership on native scope disposal and does not price a foreign replacement', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    new SessionProjectionRegistry(ctx)
    new LlmRuntime(ctx)
    const fiber = ctx.plugin({ apply(scope: Context) {
      registerNativeCodexAdapter(scope, [CODEX_PROVIDER], new FixtureAdapter())
    } })
    await fiber
    const meter = new CodexTokenMeter(ctx)
    const session = Session.create(SessionId('dispose'))
    appendCall(session, 1, { inputTokens: 200, outputTokens: 1001, reasoningTokens: 1000 })
    expect(canReplayNativeCodex(ctx.llm, CODEX_PROVIDER, CODEX_PROVIDER)).toBe(true)
    expect(meter.measure(session).nodes.at(-1)!.tokens).toBeGreaterThan(1000)
    await fiber.dispose()
    ctx.llm.registerAdapter([CODEX_PROVIDER], new ForeignAdapter())
    expect(canReplayNativeCodex(ctx.llm, CODEX_PROVIDER, CODEX_PROVIDER)).toBe(false)
    expect(meter.measure(session).nodes.at(-1)!.tokens).toBeLessThan(1000)
  })

  it('lets the unchanged compaction engine remove reasoning-heavy history and converge in one summary', async () => {
    const { ctx, meter, session } = harness()
    for (let turn = 1; turn <= 4; turn++) appendCall(session, turn, {
      inputTokens: 200 + (turn - 1) * 1000, outputTokens: 1001, reasoningTokens: 1000,
    })
    session.append('turn/start', { turn: 5 })
    class Compactor extends BasicCompactionEngine {
      calls = 0
      protected override async summarize(input: { messages: readonly Message[] }) {
        this.calls++
        expect(input.messages.some(message => message.role === 'assistant')).toBe(true)
        return { summary: [{ type: 'text' as const, text: 'earlier history' }], provider: CODEX_PROVIDER, model: MODEL }
      }
    }
    const compactor = new Compactor(ctx, { thresholdRatio: 0.8, headroomTokens: 0, maxTokens: 100, retainTokens: 2500 })
    const agent = { session, options: { provider: CODEX_PROVIDER, model: MODEL } } as Agent
    expect(meter.measure(session).totalTokens).toBe(4201)
    const uiBefore = ctx.sessionProjections.snapshot(session).values.contextPressure!
    expect(uiBefore.projectedTokens).toBe(4210)
    const result = await compactor.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    expect(result).not.toBeNull()
    expect(compactor.calls).toBe(1)
    const measuredAfter = meter.measure(session)
    expect(measuredAfter.totalTokens).toBeLessThan(4000)
    const uiAfter = ctx.sessionProjections.snapshot(session).values.contextPressure!
    expect(uiAfter.pressureTokens).toBe(uiBefore.pressureTokens)
    expect(uiAfter.projectedTokens).toBeLessThan(4000)
    expect(uiAfter.projectedTokens! - uiBefore.projectedTokens!).toBe(measuredAfter.totalTokens - 4201)
    expect(await compactor.compactIfNeeded(agent, 'pressure', new AbortController().signal)).toBeNull()
    expect(compactor.calls).toBe(1)
  })
})
