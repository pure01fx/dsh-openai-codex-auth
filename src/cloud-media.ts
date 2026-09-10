/** Caller-scoped image sources and policy-enforced original artifacts. */
import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { imageSize } from 'image-size';
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { ShellExecutor } from '@deepseek-ai/dsh-shell';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { MAX_IMAGE_BYTES, imageMediaType, validateImageSelection, type ImageSelection, type ParsedImageResponse } from './cloud-images.js';

export interface MediaSourceDependencies {
  fs: Pick<FileSystem, 'resolve' | 'readBytes' | 'processPath'>;
  attachments: Pick<AttachmentStore, 'readImage' | 'validateImage'>;
  /** Only verified references visible in the caller session, in chronological order. */
  visibleImages: readonly ImageAttachmentRef[];
  workspace: string;
  signal?: AbortSignal;
}
export interface ResolvedCloudImage {
  image_url: string; data: Uint8Array; mediaType: ImageMediaType;
  width: number; height: number; scaled: boolean;
  attachment?: ImageAttachmentRef; path?: string;
}
// Check both process-world grammars without resolving against the plugin host OS.
function absoluteWorldPath(path: string): boolean {
  return !path.includes('\0') && (posix.isAbsolute(path) || (win32.isAbsolute(path) && /^[A-Za-z]:|^\\\\[^\\]+\\[^\\]+/.test(path)));
}
function encodedDimensions(data: Uint8Array) {
  const { width, height } = imageSize(data);
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid decoded image dimensions');
  return { width, height };
}
export async function resolveImageSources(value: ImageSelection, deps: MediaSourceDependencies): Promise<ResolvedCloudImage[]> {
  const selection = validateImageSelection(value);
  const refs = new Map(deps.visibleImages.map((ref) => [String(ref.attachmentId), ref]));
  const recent = selection.num_last_images_to_include;
  if (recent !== undefined && deps.visibleImages.length < recent) throw new Error('Not enough visible images in this session');
  const sources = selection.images ?? deps.visibleImages.slice(-recent!).map((ref) => ({ attachment_id: String(ref.attachmentId) }));
  // Resolve every attachment id before performing any storage reads.
  for (const source of sources) if ('attachment_id' in source && !refs.has(source.attachment_id)) throw new Error('Image attachment is not visible in this session: ' + source.attachment_id);
  const result: ResolvedCloudImage[] = [];
  let total = 0;
  for (const source of sources) {
    deps.signal?.throwIfAborted();
    let data: Uint8Array;
    let attachment: ImageAttachmentRef | undefined;
    let path: string | undefined;
    if ('attachment_id' in source) {
      attachment = refs.get(source.attachment_id)!;
      if (!Number.isSafeInteger(attachment.bytes) || attachment.bytes <= 0 || attachment.bytes > MAX_IMAGE_BYTES - total) throw new Error('Image inputs exceed byte limit');
      const stored = await deps.attachments.readImage(attachment, deps.signal);
      data = stored.data;
      if (stored.ref.attachmentId !== attachment.attachmentId || stored.ref.bytes !== attachment.bytes ||
          stored.ref.mediaType !== attachment.mediaType || stored.ref.width !== attachment.width || stored.ref.height !== attachment.height ||
          data.length !== attachment.bytes) throw new Error('Stored image does not match visible attachment metadata');
    } else {
      if (!absoluteWorldPath(source.path)) throw new Error('Image path must be absolute');
      const target = await deps.fs.resolve(source.path, { cwd: deps.workspace, ...(deps.signal ? { signal: deps.signal } : {}) });
      data = await deps.fs.readBytes(target, deps.signal, MAX_IMAGE_BYTES - total);
      path = deps.fs.processPath(target);
    }
    total += data.length;
    if (!data.length || total > MAX_IMAGE_BYTES) throw new Error('Image inputs are empty or exceed byte limit');
    const mediaType = imageMediaType(data);
    await deps.attachments.validateImage({ data, mediaType });
    const dimensions = encodedDimensions(data);
    if (attachment && (attachment.mediaType !== mediaType || attachment.width !== dimensions.width || attachment.height !== dimensions.height)) throw new Error('Stored image bytes do not match attachment dimensions or media type');
    deps.signal?.throwIfAborted();
    result.push({ ...dimensions, data, mediaType, image_url: 'data:' + mediaType + ';base64,' + Buffer.from(data).toString('base64'),
      scaled: !!attachment?.originalDimensions,
      ...(attachment ? { attachment } : {}),
      ...(path ? { path } : {}) });
  }
  return result;
}
export interface MediaOutputDependencies {
  fs: Pick<FileSystem, 'resolve' | 'processPath' | 'contains'>;
  shell: Pick<ShellExecutor, 'resolve' | 'run' | 'sandboxMode'>;
  /** Resolve from the calling session with the public sandboxPolicy service. */
  policy: SandboxExecutionPolicy;
  attachments: Pick<AttachmentStore, 'validateImage' | 'saveImage'>;
  workspace: string;
  signal?: AbortSignal;
}
const extensions: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
function quote(value: string): string { return "'" + value.replaceAll("'", "'" + '"' + "'" + '"' + "'") + "'"; }
// Bytes travel on stdin, never in command arguments, stdout, or the model history.
const WRITE_ORIGINAL = "const fs=require('node:fs');const path=require('node:path');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=process.argv[1];fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(s,'base64'),{flag:'wx',mode:0o600});});";
export async function saveImageOutputs(response: ParsedImageResponse, deps: MediaOutputDependencies) {
  if (!absoluteWorldPath(deps.workspace)) throw new Error('Caller workspace must be absolute');
  if (!deps.policy || !deps.shell.sandboxMode) throw new Error('Original image writes require a policy-enforcing DSH shell');
  let total = 0;
  const dimensions = [];
  for (const image of response.images) {
    deps.signal?.throwIfAborted();
    total += image.data.length;
    if (!image.data.length || total > MAX_IMAGE_BYTES) throw new Error('Image outputs exceed byte limit');
    if (imageMediaType(image.data) !== image.mediaType) throw new Error('Output media type does not match bytes');
    await deps.attachments.validateImage({ data: image.data, mediaType: image.mediaType });
    dimensions.push(encodedDimensions(image.data));
  }
  const workspace = await deps.fs.resolve(deps.workspace, { ...(deps.signal ? { signal: deps.signal } : {}) });
  const images = [];
  for (const image of response.images) {
    deps.signal?.throwIfAborted();
    const name = randomUUID() + '.' + extensions[image.mediaType];
    const target = await deps.fs.resolve('.dsh/codex-images/' + name, { cwd: deps.workspace, ...(deps.signal ? { signal: deps.signal } : {}) });
    if (!deps.fs.contains(workspace, target)) throw new Error('Original image target escapes caller workspace');
    const path = deps.fs.processPath(target);
    const outcome = await deps.shell.run(deps.shell.resolve({
      command: 'node -e ' + quote(WRITE_ORIGINAL) + ' -- ' + quote(path),
      stdin: Buffer.from(image.data).toString('base64'), workdir: deps.fs.processPath(workspace),
      sandboxPolicy: deps.policy, signal: deps.signal, timeoutMs: 30_000, stdoutMaxBytes: 1024,
    }));
    if (outcome.sandbox?.denied || outcome.sandbox?.runnerFailed || outcome.exitCode !== 0 || outcome.aborted || outcome.timedOut) throw new Error('Original image write failed under caller filesystem policy');
    const attachment = await deps.attachments.saveImage({ data: image.data, mediaType: image.mediaType, name });
    images.push({ ...image.metadata, path, mediaType: image.mediaType, bytes: image.data.length,
      ...(image.generation_id ? { generation_id: image.generation_id } : {}),
      ...dimensions[images.length],
      attachment, preview: { normalized: true, scaled: !!attachment.originalDimensions, mediaType: attachment.mediaType, bytes: attachment.bytes, width: attachment.width, height: attachment.height } });
  }
  return { ...response.metadata, images };
}
