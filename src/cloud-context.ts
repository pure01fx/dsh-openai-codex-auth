/** Caller-visible context only; never project reasoning, plugin instructions or replay state. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LlmError, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm'
import type { NativeCodexModel } from './catalog.js'

export function chooseCloudModel(params: { requested?: string | undefined; configured?: string | undefined; currentProvider?: string | undefined; currentModel?: string | undefined; purpose: 'search' | 'vision' }, models: readonly NativeCodexModel[]): NativeCodexModel {
  const selected = params.requested ?? params.configured ?? (params.currentProvider === 'openai-codex' ? params.currentModel : undefined)
  if (!selected) throw new LlmError('Specify model or configure cloudTools.' + (params.purpose === 'search' ? 'searchModel' : 'visionModel') + '; the current session must otherwise use openai-codex', 'MODEL_REQUIRED')
  const model = models.find(item => item.slug === selected) ?? (selected.endsWith('-fast') ? models.find(item => item.slug === selected.slice(0, -5)) : undefined)
  if (!model) throw new LlmError('Selected Codex model is unavailable in the current account catalog', 'MODEL_NOT_FOUND')
  if (params.purpose === 'vision' && !model.inputModalities.includes('image')) throw new LlmError('Selected Codex model does not support image input', 'VISION_UNSUPPORTED')
  return model
}

/** Only results paired with a preceding call and their owning source can grant image visibility. */
export function visibleCloudImages(messages: readonly Message[]): ImageAttachmentRef[] {
  const images: ImageAttachmentRef[] = []
  const calls = new Set<string>()
  const visit = (blocks: readonly ContentBlock[], depth = 0): void => {
    if (depth > 16) return
    for (const block of blocks) {
      if (block.type === 'image') images.push(block.attachment)
      else if (block.type === 'tool-result' && !block.isError && calls.has(block.toolCallId)) visit(block.content, depth + 1)
    }
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'tool-call') calls.add(block.id)
    } else if (message.role === 'user' && message.source.kind === 'user') {
      // User messages grant only their direct images, never embedded purported tool results.
      for (const block of message.content) if (block.type === 'image') images.push(block.attachment)
    } else if (message.role === 'user' && message.source.kind === 'tool' && calls.has(message.source.callId)) {
      for (const block of message.content) if (block.type === 'tool-result' && block.toolCallId === message.source.callId && !block.isError) visit(block.content)
    }
  }
  return images
}

function boundedText(text: string, bytes: number, tail = false): string {
  const encoded = Buffer.from(text)
  if (encoded.length <= bytes) return text
  if (tail) {
    let start = encoded.length - bytes
    while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++
    return encoded.subarray(start).toString('utf8')
  }
  let end = bytes
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--
  return encoded.subarray(0, end).toString('utf8')
}
/** Last two human texts plus intervening visible assistant text. UTF-8 bytes conservatively
 * upper-bound byte-level tokenizer tokens; a single 1000-byte assistant budget avoids
 * relying on an unavailable model tokenizer. The selected human texts are preserved in full. */
export function recentSearchInput(messages: readonly Message[]): { role: 'user' | 'assistant'; content: string }[] {
  const users = messages.map((message, i) => message.role === 'user' && message.source.kind === 'user' && message.content.some(block => block.type === 'text') ? i : -1).filter(i => i >= 0).slice(-2)
  if (!users.length) return []
  const selected: { role: 'user' | 'assistant'; content: string }[] = []
  let assistantBytes = 1000
  // Budget newest text first, then restore chronology.
  for (let i = messages.length - 1; i >= users[0]!; i--) {
    const message = messages[i]!
    const user = users.includes(i)
    if (!user && (message.role !== 'assistant' || message.source.kind !== 'model')) continue
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const content = user ? text : boundedText(text, assistantBytes, true)
    if (!content) continue
    if (!user) assistantBytes -= Buffer.byteLength(content)
    selected.push({ role: user ? 'user' : 'assistant', content })
  }
  return selected.reverse()
}
