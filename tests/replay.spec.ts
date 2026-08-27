import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { CallId, type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  codexRequestBody,
  streamResponses,
  type ResolvedMessage,
} from '../src/responses.ts'
import {
  NATIVE_CODEX_REPLAY_KIND,
  createNativeCodexReplayState,
  replayAssistantInput,
  type NativeCodexReplayState,
} from '../src/replay.ts'
import { NATIVE_CODEX_PROVIDER } from '../src/native-adapter.ts'

const TOOL_REASONING_SSE = await readFile(
  new URL('./fixtures/responses-tool-reasoning.sse', import.meta.url),
  'utf8',
)

function bytes(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: NATIVE_CODEX_PROVIDER,
    model: 'gpt-base',
    messages: [],
    ...overrides,
  }
}

function finishState(chunks: readonly StreamChunk[]): NativeCodexReplayState {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  if (finish?.type !== 'finish' || finish.replayState === undefined) {
    throw new Error('expected replay state')
  }
  return finish.replayState as NativeCodexReplayState
}

describe('native Codex continuation replay', () => {
  it('captures only opaque reasoning and durable block references', async () => {
    const chunks = await collect(streamResponses(bytes(TOOL_REASONING_SSE), {
      replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base-fast' },
    }))
    const state = finishState(chunks)

    expect(state).toEqual({
      kind: NATIVE_CODEX_REPLAY_KIND,
      version: 1,
      provider: NATIVE_CODEX_PROVIDER,
      model: 'gpt-base-fast',
      items: [
        {
          type: 'reasoning', id: 'reason_redacted', blocks: [0],
          encryptedContent: 'encrypted_redacted',
        },
        { type: 'function_call', id: 'call_item_redacted', block: 1 },
      ],
    })
    const visible = JSON.stringify(chunks)
    expect(visible).not.toContain('hidden chain')
    const durable = JSON.stringify(state)
    expect(durable).toContain('encrypted_redacted')
    expect(durable).not.toContain('Checked safely.')
    expect(durable).not.toContain('lookup')
    expect(durable).not.toContain('call_redacted')
    expect(durable).not.toContain('key')
  })

  it('replays reasoning, call, and following tool output exactly once in wire order', async () => {
    const state = finishState(await collect(streamResponses(bytes(TOOL_REASONING_SSE), {
      replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base' },
    })))
    const messages: ResolvedMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Checked safely.' },
          { type: 'tool-call', id: CallId('call_redacted'), name: 'lookup', arguments: '{"key":"safe"}' },
        ],
        replaySource: {
          provider: NATIVE_CODEX_PROVIDER,
          model: 'gpt-base',
          replayState: JSON.parse(JSON.stringify(state)),
        },
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result', toolCallId: CallId('call_redacted'),
          content: [{ type: 'text', text: 'found' }],
        }],
      },
    ]

    expect(codexRequestBody(options(), messages).input).toEqual([
      {
        type: 'reasoning', id: 'reason_redacted',
        summary: [{ type: 'summary_text', text: 'Checked safely.' }],
        encrypted_content: 'encrypted_redacted',
      },
      {
        type: 'function_call', id: 'call_item_redacted',
        call_id: 'call_redacted', name: 'lookup', arguments: '{"key":"safe"}',
      },
      { type: 'function_call_output', call_id: 'call_redacted', output: 'found' },
    ])
  })

  it('retains encrypted reasoning with no visible summary before a function call', async () => {
    const sse = [
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_empty","summary":[],"encrypted_content":"opaque_empty"}}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_empty","call_id":"call_empty","name":"lookup","arguments":"{}"}}',
      '',
      'data: {"type":"response.completed","response":{}}',
      '',
      '',
    ].join('\n')
    const state = finishState(await collect(streamResponses(bytes(sse), {
      replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base' },
    })))
    expect(state.items).toEqual([
      { type: 'reasoning', id: 'rs_empty', blocks: [], encryptedContent: 'opaque_empty' },
      { type: 'function_call', id: 'fc_empty', block: 0 },
    ])
    expect(replayAssistantInput([
      { type: 'tool-call', id: CallId('call_empty'), name: 'lookup', arguments: '{}' },
    ], {
      provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base', replayState: state,
    })).toEqual([
      { type: 'reasoning', id: 'rs_empty', summary: [], encrypted_content: 'opaque_empty' },
      {
        type: 'function_call', id: 'fc_empty',
        call_id: 'call_empty', name: 'lookup', arguments: '{}',
      },
    ])
  })

  it('captures provider completion order independently of block-open order', async () => {
    const sse = [
      'data: {"type":"response.output_text.delta","item_id":"msg_first","content_index":0,"delta":"answer"}', '',
      'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_second","summary_index":0,"delta":"summary"}', '',
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_second","summary":[{"type":"summary_text","text":"summary"}],"encrypted_content":"opaque"}}', '',
      'data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_first","content":[{"type":"output_text","text":"answer"}]}}', '',
      'data: {"type":"response.completed","response":{}}', '', '',
    ].join('\n')
    const state = finishState(await collect(streamResponses(bytes(sse), {
      replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base' },
    })))
    expect(state.items).toEqual([
      { type: 'reasoning', id: 'rs_second', blocks: [1], encryptedContent: 'opaque' },
      { type: 'message', id: 'msg_first', blocks: [0] },
    ])
    expect(replayAssistantInput([
      { type: 'text', text: 'answer' },
      { type: 'reasoning', text: 'summary' },
    ], {
      provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base', replayState: state,
    }).map(item => item.type)).toEqual(['reasoning', 'message'])
  })

  it('preserves completed provider item order across messages and parallel calls', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'first' },
      { type: 'reasoning', text: 'summary' },
      { type: 'tool-call', id: CallId('call_a'), name: 'a', arguments: '{}' },
      { type: 'text', text: 'second' },
      { type: 'tool-call', id: CallId('call_b'), name: 'b', arguments: '{"b":1}' },
    ]
    const state = createNativeCodexReplayState(NATIVE_CODEX_PROVIDER, 'gpt-base', [
      { type: 'message', id: 'msg_first', blocks: [0] },
      { type: 'reasoning', id: 'rs_first', blocks: [1], encryptedContent: 'opaque' },
      { type: 'function_call', id: 'fc_a', block: 2 },
      { type: 'message', id: 'msg_second', blocks: [3] },
      { type: 'function_call', id: 'fc_b', block: 4 },
    ])
    expect(replayAssistantInput(content, {
      provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base', replayState: state,
    }).map(item => item.type)).toEqual([
      'message', 'reasoning', 'function_call', 'message', 'function_call',
    ])
  })

  it('normalizes long call ids globally without mutating replay state', () => {
    const longId = 'x'.repeat(80)
    const state = createNativeCodexReplayState(NATIVE_CODEX_PROVIDER, 'gpt-base', [
      { type: 'function_call', id: 'fc_long', block: 0 },
    ])!
    const stateBefore = JSON.stringify(state)
    const input = codexRequestBody(options(), [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId(longId), name: 'lookup', arguments: '{}' }],
        replaySource: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base', replayState: state },
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result', toolCallId: CallId(longId),
          content: [{ type: 'text', text: 'ok' }],
        }],
      },
    ]).input as Array<Record<string, unknown>>
    expect(input[0]?.call_id).toBe(input[1]?.call_id)
    expect(String(input[0]?.call_id)).toHaveLength(64)
    expect(JSON.stringify(state)).toBe(stateBefore)
  })

  it('round-trips through JSON and rejects provenance, references, and coverage drift', () => {
    const valid = createNativeCodexReplayState(NATIVE_CODEX_PROVIDER, 'gpt-base', [
      { type: 'message', blocks: [0] },
    ])!
    const content: ContentBlock[] = [{ type: 'text', text: 'ok' }]
    expect(replayAssistantInput(content, {
      provider: NATIVE_CODEX_PROVIDER,
      model: 'gpt-base',
      replayState: JSON.parse(JSON.stringify(valid)),
    })).toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }])

    for (const replayState of [
      { ...valid, provider: 'foreign' },
      { ...valid, model: 'foreign' },
      { ...valid, kind: 'foreign' },
      { ...valid, version: 2 },
      { ...valid, items: [{ type: 'message', id: 'unprefixed', blocks: [0] }] },
      { ...valid, items: [{ type: 'message', blocks: [1] }] },
      { ...valid, items: [{ type: 'message', blocks: [0, 0] }] },
      { ...valid, items: [{ type: 'reasoning', blocks: [0] }] },
    ]) {
      expect(() => replayAssistantInput(content, {
        provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base', replayState,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_REPLAY_STATE' }))
    }
  })

  it('enforces replay limits while completed items are still streaming', async () => {
    const manyItems = Array.from({ length: 129 }, (_, index) => [
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: `rs_${index}`, summary: [] },
      })}`,
      '',
    ]).flat().concat('').join('\n')
    await expect(collect(streamResponses(bytes(manyItems), {
      replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base' },
    }))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })

    const oversized = [
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'reasoning', id: 'rs_large', summary: [],
          encrypted_content: 'x'.repeat(1024 * 1024 + 1),
        },
      })}`, '', '',
    ].join('\n')
    await expect(collect(streamResponses(bytes(oversized), {
      maxEventBytes: 2 * 1024 * 1024,
      replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base' },
    }))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('enforces descriptor and encrypted-content bounds', () => {
    expect(createNativeCodexReplayState(NATIVE_CODEX_PROVIDER, 'gpt-base', [{
      type: 'reasoning', blocks: [], encryptedContent: 'x'.repeat(1024 * 1024),
    }])).toBeDefined()
    expect(() => createNativeCodexReplayState(NATIVE_CODEX_PROVIDER, 'gpt-base', [{
      type: 'reasoning', blocks: [], encryptedContent: 'x'.repeat(1024 * 1024 + 1),
    }])).toThrowError()
    expect(() => createNativeCodexReplayState(
      NATIVE_CODEX_PROVIDER,
      'gpt-base',
      Array.from({ length: 129 }, () => ({ type: 'reasoning' as const, blocks: [] })),
    )).toThrowError()
    expect(createNativeCodexReplayState(NATIVE_CODEX_PROVIDER, 'gpt-base', [{
      type: 'message', id: 'i_' + 'x'.repeat(254),
      blocks: Array.from({ length: 256 }, (_, index) => index),
    }])).toBeDefined()
    expect(() => createNativeCodexReplayState(NATIVE_CODEX_PROVIDER, 'gpt-base', [{
      type: 'message', id: 'i_' + 'x'.repeat(255),
      blocks: Array.from({ length: 257 }, (_, index) => index),
    }])).toThrowError()
    expect(() => createNativeCodexReplayState(
      NATIVE_CODEX_PROVIDER,
      'gpt-base',
      Array.from({ length: 5 }, () => ({
        type: 'reasoning' as const,
        blocks: [],
        encryptedContent: 'x'.repeat(1024 * 1024),
      })),
    )).toThrowError(expect.objectContaining({ code: 'REPLAY_STATE_TOO_LARGE' }))
  })

  it('rejects malformed completed reasoning summaries and ciphertext', async () => {
    for (const item of [
      { type: 'reasoning', id: 'rs_bad', encrypted_content: 'opaque' },
      { type: 'reasoning', id: 'rs_bad', summary: [{ text: 'missing tag' }], encrypted_content: 'opaque' },
      { type: 'reasoning', id: 'rs_bad', summary: [], encrypted_content: { invalid: true } },
    ]) {
      const sse = [
        `data: ${JSON.stringify({ type: 'response.output_item.done', item })}`, '',
        'data: {"type":"response.completed","response":{}}', '', '',
      ].join('\n')
      await expect(collect(streamResponses(bytes(sse), {
        replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base' },
      }))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    }
  })

  it('accepts null encrypted reasoning as pinned optional absence', async () => {
    const sse = [
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_null","summary":[],"encrypted_content":null}}', '',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_null","call_id":"call_null","name":"lookup","arguments":"{}"}}', '',
      'data: {"type":"response.completed","response":{}}', '', '',
    ].join('\n')
    expect(finishState(await collect(streamResponses(bytes(sse), {
      replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base' },
    }))).items).toEqual([
      { type: 'reasoning', id: 'rs_null', blocks: [] },
      { type: 'function_call', id: 'fc_null', block: 0 },
    ])
  })

  it('rejects successful streams whose visible blocks lack completed descriptors', async () => {
    const incompleteReplay = [
      'data: {"type":"response.output_text.delta","item_id":"msg_missing_done","delta":"part"}', '',
      'data: {"type":"response.completed","response":{}}', '', '',
    ].join('\n')
    await expect(collect(streamResponses(bytes(incompleteReplay), {
      replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base' },
    }))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('never attaches replay state to failure, truncation, or max-token incomplete', async () => {
    const failed = [
      'data: {"type":"response.failed","response":{"error":{"code":"server_error"}}}', '', '',
    ].join('\n')
    await expect(collect(streamResponses(bytes(failed), {
      replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base' },
    }))).rejects.toMatchObject({ code: 'SERVER' })

    const incomplete = [
      'data: {"type":"response.output_text.delta","item_id":"msg_partial","delta":"part"}', '',
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}', '', '',
    ].join('\n')
    const chunks = await collect(streamResponses(bytes(incomplete), {
      replayContext: { provider: NATIVE_CODEX_PROVIDER, model: 'gpt-base' },
    }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})
