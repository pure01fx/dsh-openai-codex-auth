import { describe, expect, it } from 'vitest'
import { NativeCodexWebSocketSessionState } from '../src/native-websocket-session.ts'

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-base',
    instructions: 'system',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: 'medium', summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'cache',
    ...overrides,
  }
}

describe('NativeCodexWebSocketSessionState', () => {
  it('prewarms with generate false then reuses an empty incremental suffix', () => {
    const state = new NativeCodexWebSocketSessionState()
    const full = request()
    expect(state.prewarm(full)).toEqual({
      payload: { type: 'response.create', ...full, generate: false },
      incremental: false,
    })
    state.complete('resp_warm', [])
    expect(state.plan(full, true)).toEqual({
      payload: {
        type: 'response.create', ...full,
        previous_response_id: 'resp_warm', input: [],
      },
      incremental: true,
      previousResponseId: 'resp_warm',
    })
  })

  it('sends only the strict suffix after prior server output', () => {
    const state = new NativeCodexWebSocketSessionState()
    const first = request()
    state.plan(first)
    const output = {
      type: 'function_call', id: 'fc_one', call_id: 'call_one',
      name: 'lookup', arguments: '{}',
    }
    state.complete('resp_one', [output])
    const result = {
      type: 'function_call_output', call_id: 'call_one', output: 'found',
    }
    const next = request({ input: [...first.input as unknown[], output, result] })
    expect(state.plan(next)).toEqual({
      payload: {
        type: 'response.create', ...next,
        previous_response_id: 'resp_one', input: [result],
      },
      incremental: true,
      previousResponseId: 'resp_one',
    })
  })

  it('keeps incremental reuse beyond 2048 historical input items', () => {
    const state = new NativeCodexWebSocketSessionState()
    const history = Array.from({ length: 2049 }, (_, index) => ({
      type: 'message', role: 'user', content: [{ type: 'input_text', text: String(index) }],
    }))
    const first = request({ input: history })
    const initial = state.plan(first)
    expect(initial.incremental).toBe(false)
    expect(initial.payload.input).toHaveLength(2049)

    const output = {
      type: 'function_call', id: 'fc_large', call_id: 'call_large',
      name: 'lookup', arguments: '{}',
    }
    state.complete('resp_large', [output])
    const result = { type: 'function_call_output', call_id: 'call_large', output: 'found' }
    const next = request({ input: [...history, output, result] })
    expect(state.plan(next)).toEqual({
      payload: {
        type: 'response.create', ...next,
        previous_response_id: 'resp_large', input: [result],
      },
      incremental: true,
      previousResponseId: 'resp_large',
    })
  })

  it('falls back to a full create for non-prefix or property changes', () => {
    const output = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }
    for (const next of [
      request({ input: [{ type: 'message', role: 'user', content: [] }] }),
      request({ model: 'other', input: [...request().input as unknown[], output, { type: 'message' }] }),
      request({ service_tier: 'priority', input: [...request().input as unknown[], output, { type: 'message' }] }),
      request({ instructions: 'changed', input: [...request().input as unknown[], output, { type: 'message' }] }),
    ]) {
      const state = new NativeCodexWebSocketSessionState()
      state.plan(request())
      state.complete('resp_previous', [output])
      expect(state.plan(next)).toEqual({
        payload: { type: 'response.create', ...next },
        incremental: false,
      })
    }
  })

  it('ignores per-request metadata fields when deciding reuse', () => {
    const state = new NativeCodexWebSocketSessionState()
    const first = request({ client_metadata: { trace: 'one' }, stream_options: { include_usage: true } })
    state.plan(first)
    state.complete('resp_metadata', [])
    const marker = { type: 'message', role: 'user', content: [] }
    const next = request({
      input: [...first.input as unknown[], marker],
      client_metadata: { trace: 'two' },
      stream_options: { include_usage: false },
    })
    expect(state.plan(next)).toMatchObject({
      incremental: true,
      previousResponseId: 'resp_metadata',
      payload: { input: [marker] },
    })
  })

  it('resets previous-response reuse after failure or invalid completion', () => {
    const state = new NativeCodexWebSocketSessionState()
    const first = request()
    state.plan(first)
    state.complete('resp_previous', [])
    state.reset()
    expect(state.plan(first, true)).toEqual({
      payload: { type: 'response.create', ...first },
      incremental: false,
    })

    expect(() => state.complete('', [])).toThrowError(
      expect.objectContaining({ code: 'WS_PROTOCOL_ERROR' }),
    )
    expect(state.plan(first, true)).toMatchObject({ incremental: false })
  })

  it('bounds response and completion identities', () => {
    const state = new NativeCodexWebSocketSessionState()
    state.plan(request())
    expect(() => state.complete('r'.repeat(257), []))
      .toThrowError(expect.objectContaining({ code: 'WS_PROTOCOL_ERROR' }))
    state.plan(request())
    expect(() => state.complete('resp_many', Array.from(
      { length: 2049 }, () => ({ type: 'message' }),
    ))).toThrowError(expect.objectContaining({ code: 'WS_PROTOCOL_ERROR' }))
  })
})
