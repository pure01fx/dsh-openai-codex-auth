import { describe, expect, it, vi } from 'vitest'
import {
  parseCodexResponseUsageMetadata,
  publishCodexResponseUsage,
} from '../src/response-usage.ts'

describe('Codex response usage metadata', () => {
  it('preserves exact amounts and complete raw usage without numeric coercion', () => {
    expect(parseCodexResponseUsageMetadata({
      type: 'response.completed',
      response: {
        usage_metadata: { amount: '0.12345678901234567890' },
        usage: { input_tokens: 12, total_tokens: 15, codex_rollout_budget_units: 7 },
      },
    })).toEqual({
      amount: '0.12345678901234567890',
      metadata: { input_tokens: 12, total_tokens: 15, codex_rollout_budget_units: 7 },
    })
    expect(parseCodexResponseUsageMetadata({
      type: 'response.completed', response: { usage: { future_counter: 9 } },
    })).toEqual({ metadata: { future_counter: 9 } })
    expect(parseCodexResponseUsageMetadata({
      type: 'response.completed', response: { usage_metadata: { amount: null } },
    })).toBeUndefined()
    expect(parseCodexResponseUsageMetadata({
      type: 'response.created',
      response: { usage_metadata: { amount: '1' }, usage: { total_tokens: 1 } },
    })).toBeUndefined()
  })

  it('bounds malformed metadata and contains observer failures', () => {
    expect(parseCodexResponseUsageMetadata({
      type: 'response.completed',
      response: { usage_metadata: { amount: 'x'.repeat(257) } },
    })).toBeUndefined()
    expect(parseCodexResponseUsageMetadata({
      type: 'response.completed',
      response: {
        usage_metadata: { amount: '1.25' },
        usage: { oversized: 'x'.repeat(64 * 1024) },
      },
    })).toEqual({ amount: '1.25' })
    const warn = vi.fn()
    expect(() => publishCodexResponseUsage(
      'acct',
      { amount: '1.25' },
      () => { throw new Error('observer failed') },
      warn,
    )).not.toThrow()
    expect(warn).toHaveBeenCalledWith('native Codex response usage metadata could not be published')
  })
})
