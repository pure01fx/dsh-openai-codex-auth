import { describe, expect, it, vi } from 'vitest'
import {
  parseCodexResponseUsageMetadata,
  publishCodexResponseUsage,
} from '../src/response-usage.ts'

describe('Codex response usage metadata', () => {
  it('preserves exact high-precision completion amounts without numeric coercion', () => {
    expect(parseCodexResponseUsageMetadata({
      type: 'response.completed',
      response: { usage_metadata: { amount: '0.12345678901234567890' } },
    })).toEqual({ amount: '0.12345678901234567890' })
    expect(parseCodexResponseUsageMetadata({
      type: 'response.completed', response: { usage_metadata: { amount: null } },
    })).toBeUndefined()
    expect(parseCodexResponseUsageMetadata({
      type: 'response.created',
      response: { usage_metadata: { amount: '1' } },
    })).toBeUndefined()
  })

  it('bounds malformed metadata and contains observer failures', () => {
    expect(parseCodexResponseUsageMetadata({
      type: 'response.completed',
      response: { usage_metadata: { amount: 'x'.repeat(257) } },
    })).toBeUndefined()
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
