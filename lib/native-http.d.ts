import { type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { type NativeCodexCredential } from './catalog.js';
import { type NativeCodexTransportMode } from './native-adapter.js';
import { type CodexResponseUsageCallback } from './response-usage.js';
import { type CodexRateLimitCallback } from './rate-limits.js';
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
    onRateLimits?: CodexRateLimitCallback;
    onResponseUsage?: CodexResponseUsageCallback;
    warn?: (message: string) => void;
}
export interface NativeCodexPreparedRequest {
    generation: GenerateOptions;
    mode: NativeCodexTransportMode;
    request: Record<string, unknown>;
    body: string;
    routingId: string;
    routingHint: string;
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
    private waitForConnection;
    endpointUrl(): string;
    prepare(generation: GenerateOptions, mode?: NativeCodexTransportMode): Promise<NativeCodexPreparedRequest>;
    stream(generation: GenerateOptions, mode?: NativeCodexTransportMode): AsyncIterable<StreamChunk>;
}
export {};
