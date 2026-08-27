import { type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { NativeCodexCredential } from './catalog.js';
export declare const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
type ImageBlock = Extract<ContentBlock, {
    type: 'image';
}>;
export interface NativeCodexImageRead {
    data: Uint8Array;
}
export interface NativeCodexHttpOptions {
    resolveCredential(signal?: AbortSignal): Promise<NativeCodexCredential>;
    recoverCredential?(previous: NativeCodexCredential, signal?: AbortSignal): Promise<boolean>;
    readImage?(attachment: ImageBlock['attachment'], signal?: AbortSignal): Promise<NativeCodexImageRead>;
    fetch?: typeof fetch;
    endpoint?: string;
    requestTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
    maxSseEventBytes?: number;
    maxTransientRetries?: number;
    initialRetryDelayMs?: number;
    maxRetryDelayMs?: number;
    maxRequestBodyBytes?: number;
    random?: () => number;
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    createRequestId?: () => string;
    onCompleted?: () => void;
    warn?: (message: string) => void;
}
/** HTTP Responses transport. It never retains a credential outside one attempt. */
export declare class NativeCodexHttpTransport {
    private readonly options;
    private readonly fetchImpl;
    private readonly endpoint;
    private readonly requestTimeoutMs;
    private readonly idleTimeoutMs;
    private readonly maxRetries;
    private readonly initialDelayMs;
    private readonly maxDelayMs;
    private readonly maxBodyBytes;
    constructor(options: NativeCodexHttpOptions);
    private retryDelay;
    private wait;
    stream(generation: GenerateOptions): AsyncIterable<StreamChunk>;
}
export {};
