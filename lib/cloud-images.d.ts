/** Pure image endpoint validation and decoding. */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';
export type ImageSource = {
    attachment_id: string;
} | {
    path: string;
};
export interface ImageSelection {
    images?: ImageSource[];
    num_last_images_to_include?: number;
}
export interface ImageGenerateArgs {
    prompt: string;
    model: string;
    quality: 'auto' | 'low' | 'medium' | 'high';
    background: 'auto' | 'transparent' | 'opaque';
    size: string;
    n?: number;
}
export type ImageEditArgs = ImageGenerateArgs & ImageSelection;
export declare function validateImageSelection(value: unknown): ImageSelection;
export declare function validateImageGenerateArgs(value: unknown, defaultModel?: string): ImageGenerateArgs;
export declare function validateImageEditArgs(value: unknown, defaultModel?: string): ImageEditArgs;
export declare function buildImageGenerationRequest(value: unknown, defaultModel?: string): ImageGenerateArgs;
export declare function buildImageEditRequest(value: unknown, images: readonly {
    image_url: string;
}[], defaultModel?: string): {
    images: {
        image_url: string;
    }[];
    prompt: string;
    model: string;
    quality: "auto" | "low" | "medium" | "high";
    background: "auto" | "transparent" | "opaque";
    size: string;
    n?: number;
};
export declare function decodeImageBase64(value: unknown): Uint8Array;
export declare function imageMediaType(data: Uint8Array): ImageMediaType;
export interface ParsedCloudImage {
    data: Uint8Array;
    mediaType: ImageMediaType;
    generation_id?: string;
    metadata: Record<string, unknown>;
}
export interface ParsedImageResponse {
    images: ParsedCloudImage[];
    metadata: Record<string, unknown>;
}
export declare function parseImageResponse(value: unknown, requestId?: string): ParsedImageResponse;
