import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { ShellExecutor } from '@deepseek-ai/dsh-shell';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { type ImageSelection, type ParsedImageResponse } from './cloud-images.js';
export interface MediaSourceDependencies {
    fs: Pick<FileSystem, 'resolve' | 'readBytes' | 'processPath'>;
    attachments: Pick<AttachmentStore, 'readImage' | 'validateImage'>;
    /** Only verified references visible in the caller session, in chronological order. */
    visibleImages: readonly ImageAttachmentRef[];
    workspace: string;
    signal?: AbortSignal;
}
export interface ResolvedCloudImage {
    image_url: string;
    data: Uint8Array;
    mediaType: ImageMediaType;
    width: number;
    height: number;
    scaled: boolean;
    attachment?: ImageAttachmentRef;
    path?: string;
}
export declare function resolveImageSources(value: ImageSelection, deps: MediaSourceDependencies): Promise<ResolvedCloudImage[]>;
export interface MediaOutputDependencies {
    fs: Pick<FileSystem, 'resolve' | 'processPath' | 'contains'>;
    shell: Pick<ShellExecutor, 'resolve' | 'run' | 'sandboxMode'>;
    /** Resolve from the calling session with the public sandboxPolicy service. */
    policy: SandboxExecutionPolicy;
    attachments: Pick<AttachmentStore, 'validateImage' | 'saveImage'>;
    workspace: string;
    signal?: AbortSignal;
}
export declare function saveImageOutputs(response: ParsedImageResponse, deps: MediaOutputDependencies): Promise<{
    images: {
        attachment: ImageAttachmentRef;
        preview: {
            normalized: boolean;
            scaled: boolean;
            mediaType: ImageMediaType;
            bytes: number;
            width: number;
            height: number;
        };
        width: number;
        height: number;
        generation_id?: string;
        path: string;
        mediaType: ImageMediaType;
        bytes: number;
    }[];
}>;
