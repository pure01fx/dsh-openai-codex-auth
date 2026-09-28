import type { NativeCodexCredential } from './catalog.js';
export interface NativeCodexCloudOptions {
    resolveCredential(signal?: AbortSignal): Promise<NativeCodexCredential>;
    recoverCredential?(previous: NativeCodexCredential, signal?: AbortSignal): Promise<boolean>;
    fetch?: typeof fetch;
    endpoint?: string;
    requestTimeoutMs?: number;
}
export interface NativeCodexCloudPostOptions {
    credential: NativeCodexCredential;
    signal: AbortSignal;
    headers?: Record<string, string>;
    timeoutMs?: number;
}
export type NativeCodexCloudPath = 'alpha/search' | 'images/generations' | 'images/edits';
export declare class NativeCodexCloudClient {
    private readonly options;
    private readonly endpoint;
    constructor(options: NativeCodexCloudOptions);
    resolveCredential(signal?: AbortSignal): Promise<NativeCodexCredential>;
    post(path: NativeCodexCloudPath, body: Record<string, unknown>, options: NativeCodexCloudPostOptions): Promise<{
        body: unknown;
        requestId?: string;
    }>;
}
