import { type TokenUsage } from '@deepseek-ai/dsh-llm';
import type { NativeCodexCredential, NativeCodexModel } from './catalog.js';
import { type NativeCodexHttpOptions } from './native-http.js';
import type { CodexImageDetail } from './responses.js';
import { type ImageSource } from './cloud-images.js';
import type { ResolvedCloudImage } from './cloud-media.js';
export interface CloudVisionArgs {
    prompt: string;
    images: ImageSource[];
    model?: string;
    detail?: CodexImageDetail;
    reasoning_effort?: string;
}
export declare function parseCloudVisionArgs(value: unknown): CloudVisionArgs;
export interface CloudVisionDependencies {
    model: NativeCodexModel;
    credential: NativeCodexCredential;
    images: readonly ResolvedCloudImage[];
    signal: AbortSignal;
    defaultDetail?: CodexImageDetail;
    transport: NativeCodexHttpOptions;
}
export declare function inspectCloudImages(args: CloudVisionArgs, deps: CloudVisionDependencies): Promise<{
    images: {
        requested_detail: CodexImageDetail;
        effective_detail: string;
        width: number;
        height: number;
        scaled: boolean;
    }[];
    usage?: TokenUsage;
    text: string;
    model: string;
}>;
