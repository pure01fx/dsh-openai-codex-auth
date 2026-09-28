/** Ordinary DSH image tools; cloud credentials never enter tool arguments. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import { nativeCodexAuthorityHash, type NativeCodexModelCatalog } from './catalog.js'
import { NativeCodexCloudClient } from './cloud-http.js'
import { buildImageGenerationRequest, buildImageEditRequest, parseImageResponse, validateImageEditArgs } from './cloud-images.js'
import { resolveImageSources, saveImageOutputs } from './cloud-media.js'
import { inspectCloudImages, parseCloudVisionArgs } from './cloud-vision.js'
import type { NativeCodexHttpOptions } from './native-http.js'
import type { CodexImageDetail } from './responses.js'
import { chooseCloudModel, visibleCloudImages } from './cloud-context.js'

export interface CloudToolsConfig {
  enabled?: boolean
  search?: boolean
  imageGeneration?: boolean
  imageEditing?: boolean
  imageInspection?: boolean
  searchModel?: string
  visionModel?: string
  imageModel?: string
  searchMode?: 'cached' | 'indexed' | 'live'
  visionDetail?: CodexImageDetail
}
export interface CloudToolsDependencies {
  client: NativeCodexCloudClient
  catalog: NativeCodexModelCatalog
  transport: NativeCodexHttpOptions
  config: CloudToolsConfig
}
const imageRefs = { type: 'array', minItems: 1, maxItems: 5, description: 'Images visible in this session, or absolute file paths read under your file policy. Preserve order.', items: {
  oneOf: [
    { type: 'object', properties: { attachment_id: { type: 'string' } }, required: ['attachment_id'], additionalProperties: false },
    { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  ],
} }
const common = {
  prompt: { type: 'string', description: 'Describe the image to generate or the edits to perform.', minLength: 1 },
  model: { type: 'string', description: 'Optional Codex image model; defaults to configured imageModel or gpt-image-2.' },
  quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
  background: { type: 'string', enum: ['auto', 'transparent', 'opaque'] },
  size: { type: 'string', description: 'auto or a service-supported WIDTHxHEIGHT, such as 1024x1024.' },
  n: { type: 'integer', minimum: 1, maximum: 4, description: 'Optional number of images; omitted by default.' },
}
const resultSchema = { type: 'object' as const, additionalProperties: true }
function render(_args: unknown, value: unknown): ContentBlock[] {
  const row = value as { images?: { attachment?: ImageBlock['attachment'] }[]; image_output?: boolean }
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(value) }]
  if (row.image_output) for (const image of row.images ?? []) if (image.attachment) content.push({ type: 'image', attachment: image.attachment })
  return content
}
function requireAgent(exec: ToolRunContext): asserts exec is ToolRunContext & { agent: Agent } {
  if (!exec.agent) throw new Error('Codex cloud tools require an agent session')
}
const recentImages = new WeakMap<object, { historyLength: number; refs: ImageBlock['attachment'][] }>()
function mediaContext(exec: ToolRunContext) {
  requireAgent(exec)
  const ctx = exec.agent.ctx
  const workspace = exec.agent.session.header.cwd
  if (!workspace || !ctx.fs || !ctx.attachments) throw new Error('Codex image tools require the caller workspace, filesystem and attachment services')
  const messages = exec.agent.session.deriveMessages()
  const cached = recentImages.get(exec.agent.session)
  const visible = visibleCloudImages(messages)
  if (cached?.historyLength === messages.length) {
    for (const ref of cached.refs) if (!visible.some(value => value.attachmentId === ref.attachmentId)) visible.push(ref)
  } else recentImages.delete(exec.agent.session)
  return { fs: ctx.fs, attachments: ctx.attachments, workspace, signal: exec.signal, visibleImages: visible }
}
async function imageOutputSupported(exec: ToolRunContext): Promise<boolean> {
  requireAgent(exec)
  const { provider, model } = exec.agent.options
  if (!provider || !model || !exec.agent.ctx.llm) return false
  try { return (await exec.agent.ctx.llm.resolveModelInfo(provider, model, exec.signal)).inputModalities?.includes('image') ?? false }
  catch { exec.signal.throwIfAborted(); return false }
}
export function registerCodexImageTools(ctx: Context, deps: CloudToolsDependencies): void {
  const config = deps.config
  if (config.enabled === false) return
  const output = { schema: resultSchema, render }
  for (const kind of ['generate', 'edit'] as const) {
    if (kind === 'generate' ? config.imageGeneration === false : config.imageEditing === false) continue
    const tool: ToolDefinition = {
      name: 'codex_image_' + kind,
      description: kind === 'generate' ? 'Generate images using the current Codex account. Returns original file paths and image attachments for display or further editing.'
        : 'Edit 1–5 images with the current Codex account. Use explicit images OR num_last_images_to_include. Returns originals and preview attachments. Does not support mask/seed parameters.',
      parameters: { type: 'object', additionalProperties: false, properties: { ...common, ...(kind === 'edit' ? {
        images: imageRefs, num_last_images_to_include: { type: 'integer', minimum: 1, maximum: 5, description: 'Use the most recent visible session images; mutually exclusive with images.' },
      } : {}) }, required: ['prompt'] },
      output, timeoutMs: 180_000, isConcurrencySafe: () => false,
      async execute(value, exec) {
        requireAgent(exec)
        const media = mediaContext(exec)
        const scope = exec.agent.ctx
        if (!scope.shell?.sandboxMode || !scope.sandboxPolicy) throw new Error('Codex image output requires the policy-enforcing shell and sandboxPolicy services')
        const policy = scope.sandboxPolicy.resolve({ session: exec.agent.session })
        const credential = await deps.client.resolveCredential(exec.signal)
        const args = kind === 'edit' ? validateImageEditArgs(value, config.imageModel) : buildImageGenerationRequest(value, config.imageModel)
        const request = kind === 'edit' ? buildImageEditRequest(value, await resolveImageSources(validateImageEditArgs(value, config.imageModel), media), config.imageModel) : { ...args }
        const result = await deps.client.post(kind === 'edit' ? 'images/edits' : 'images/generations', request,
          { credential, signal: exec.signal })
        const saved = await saveImageOutputs(parseImageResponse(result.body, result.requestId), { ...media, shell: scope.shell, policy })
        const image_output = await imageOutputSupported(exec)
        const old = recentImages.get(exec.agent.session)?.refs ?? []
        recentImages.set(exec.agent.session, { historyLength: exec.agent.session.deriveMessages().length,
          refs: [...old, ...saved.images.map(image => image.attachment)].slice(-20) })
        return { ...saved, image_output }
      },
    }
    ctx.tools.register(tool)
  }
  if (config.imageInspection !== false) ctx.tools.register({
    name: 'codex_image_inspect',
    description: 'Ask a Codex vision model to analyze images, OCR, screenshots or charts. This makes one additional cloud inference call, without recursive tools. Use explicit model or configured visionModel for non-Codex callers. Reports effective detail and actual dimensions.',
    parameters: { type: 'object', additionalProperties: false, required: ['prompt', 'images'], properties: {
      prompt: { type: 'string', minLength: 1 }, images: imageRefs,
      model: { type: 'string' }, detail: { type: 'string', enum: ['auto', 'low', 'high', 'original'] }, reasoning_effort: { type: 'string' },
    } },
    output, timeoutMs: 120_000, isConcurrencySafe: () => true,
    async execute(value, exec) {
        requireAgent(exec)
      const args = parseCloudVisionArgs(value)
      const credential = await deps.client.resolveCredential(exec.signal)
      const view = await deps.catalog.listWithAuthority?.(exec.signal) ?? { models: await deps.catalog.list(exec.signal) }
      if (view.authorityHash !== undefined && view.authorityHash !== nativeCodexAuthorityHash(credential.accountId)) throw new Error('Codex account changed before image inspection; retry with the current account')
      const model = chooseCloudModel({ purpose: 'vision', ...(args.model === undefined ? {} : { requested: args.model }),
        ...(config.visionModel === undefined ? {} : { configured: config.visionModel }),
        ...exec.agent.options.provider === undefined ? {} : { currentProvider: exec.agent.options.provider },
        ...exec.agent.options.model === undefined ? {} : { currentModel: exec.agent.options.model },
      }, view.models)
      const images = await resolveImageSources({ images: args.images }, mediaContext(exec))
      return inspectCloudImages(args, { credential, model, images, signal: exec.signal, transport: deps.transport,
        ...(config.visionDetail === undefined ? {} : { defaultDetail: config.visionDetail }) })
    },
  })
}