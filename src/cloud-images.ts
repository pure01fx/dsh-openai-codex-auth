/** Pure image endpoint validation and decoding. */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';

export type ImageSource = { attachment_id: string } | { path: string };
export interface ImageSelection { images?: ImageSource[]; num_last_images_to_include?: number }
export interface ImageGenerateArgs {
  prompt: string; model: string; quality: 'auto' | 'low' | 'medium' | 'high';
  background: 'auto' | 'transparent' | 'opaque'; size: string; n?: number;
}
export type ImageEditArgs = ImageGenerateArgs & ImageSelection;
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max?: number): string {
  if (typeof value !== 'string' || !value.trim() || (max !== undefined && value.length > max)) throw new Error(label + ' must be a valid nonempty string');
  return value;
}
function count(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new Error(label + ' must be an integer from 1 to ' + max);
  return value;
}
function choice<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error('Invalid ' + label);
  return value as T;
}
export function validateImageSelection(value: unknown): ImageSelection {
  const a = object(value, 'Image selection');
  if ((a.images !== undefined) === (a.num_last_images_to_include !== undefined)) throw new Error('Provide exactly one of images or num_last_images_to_include');
  if (a.images === undefined) return { num_last_images_to_include: count(a.num_last_images_to_include, 'num_last_images_to_include', 5) };
  if (!Array.isArray(a.images) || a.images.length < 1 || a.images.length > 5) throw new Error('images must contain 1 to 5 references');
  return { images: a.images.map((source) => {
    const s = object(source, 'Image reference');
    if (Object.keys(s).length !== 1) throw new Error('Image reference must contain only attachment_id or path');
    if (s.attachment_id !== undefined) return { attachment_id: text(s.attachment_id, 'attachment_id', 512) };
    return { path: text(s.path, 'path', 4096) };
  }) };
}
export function validateImageGenerateArgs(value: unknown, defaultModel = 'gpt-image-2'): ImageGenerateArgs {
  const a = object(value, 'Image arguments');
  const size = text(a.size ?? 'auto', 'size', 64);
  if (size !== 'auto' && !/^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$/.test(size)) throw new Error('size must be auto or WIDTHxHEIGHT; model support is determined by the service');
  return {
    prompt: text(a.prompt, 'prompt'), model: text(a.model ?? defaultModel, 'model', 256),
    quality: choice(a.quality ?? 'auto', 'quality', ['auto', 'low', 'medium', 'high']),
    background: choice(a.background ?? 'auto', 'background', ['auto', 'transparent', 'opaque']), size,
    ...(a.n === undefined ? {} : { n: count(a.n, 'n', 4) }),
  };
}
export function validateImageEditArgs(value: unknown, defaultModel?: string): ImageEditArgs {
  return { ...validateImageGenerateArgs(value, defaultModel), ...validateImageSelection(value) };
}
export function buildImageGenerationRequest(value: unknown, defaultModel?: string): ImageGenerateArgs {
  return validateImageGenerateArgs(value, defaultModel);
}
export function buildImageEditRequest(value: unknown, images: readonly { image_url: string }[], defaultModel?: string) {
  const args = validateImageEditArgs(value, defaultModel);
  const expected = args.images?.length ?? args.num_last_images_to_include;
  if (images.length !== expected) throw new Error('Resolved image count does not match selection');
  for (const image of images) {
    const match = /^data:(image[/](?:png|jpeg|webp|gif));base64,(.*)$/.exec(image.image_url);
    if (!match) throw new Error('Edit images must be inline supported image data');
    if (imageMediaType(decodeImageBase64(match[2])) !== match[1]) throw new Error('Edit image media type does not match bytes');
  }
  return { ...validateImageGenerateArgs(value, defaultModel), images: images.map(({ image_url }) => ({ image_url })) };
}
export function decodeImageBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value.length) throw new Error('Image base64 is empty');
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid image base64');
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.toString('base64') !== value) throw new Error('Invalid image base64');
  return data;
}
export function imageMediaType(data: Uint8Array): ImageMediaType {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
  throw new Error('Unsupported or invalid image bytes');
}
export interface ParsedCloudImage { data: Uint8Array; mediaType: ImageMediaType; generation_id?: string; metadata: Record<string, unknown> }
export interface ParsedImageResponse { images: ParsedCloudImage[]; metadata: Record<string, unknown> }
export function parseImageResponse(value: unknown, requestId?: string): ParsedImageResponse {
  const response = object(value, 'Image response');
  if (!Array.isArray(response.data) || !response.data.length || response.data.length > 4) throw new Error('Image response must contain 1 to 4 data entries');
  // JSON numbers cannot preserve the entire u64 range. Reject lossy timestamps.
  if (typeof response.created !== 'number' || !Number.isSafeInteger(response.created) || response.created < 0) throw new Error('Image response created must be a lossless nonnegative u64');
  const metadata: Record<string, unknown> = { created: response.created };
  if (response.background != null) metadata.background = choice(response.background, 'response background', ['auto', 'transparent', 'opaque']);
  if (response.quality != null) metadata.quality = choice(response.quality, 'response quality', ['auto', 'low', 'medium', 'high']);
  if (response.size != null) metadata.size = text(response.size, 'response size', 64);
  if (requestId !== undefined) metadata.request_id = text(requestId, 'request_id', 512);
  const images = response.data.map((entry) => {
    const item = object(entry, 'Image response data');
    const data = decodeImageBase64(item.b64_json);
    const generation_id = item.generation_id == null ? undefined : text(item.generation_id, 'generation_id', 512);
    // Unknown fields may contain payloads or private service state; never copy them to history.
    return { data, mediaType: imageMediaType(data), metadata: generation_id === undefined ? {} : { generation_id },
      ...(generation_id === undefined ? {} : { generation_id }) };
  });
  return { images, metadata };
}
