/** Process-wide, content-free inference telemetry. All mutations are synchronous. */
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
export type NetworkState = 'preparing' | 'connecting' | 'waiting' | 'streaming' | 'retrying' | 'completed' | 'failed' | 'cancelled';
export type NetworkTransport = 'http' | 'websocket';
export interface NetworkRequest {
    id: string;
    state: NetworkState;
    transport: NetworkTransport;
    startedAt: number;
    lastActivityAt: number | null;
    lastOutputAt: number | null;
    retryAt: number | null;
    retryKind: 'transient' | 'connection' | null;
    retries: number;
    receivedBytes: number;
    attempts: number;
}
export interface NetworkSnapshot {
    scope: 'process';
    startedAt: number;
    updatedAt: number;
    activeCount: number;
    totals: {
        requests: number;
        succeeded: number;
        failed: number;
        cancelled: number;
        retries: number;
        receivedBytes: number;
    };
    requests: NetworkRequest[];
    truncated: boolean;
}
export interface NetworkRequestHandle {
    state(state: 'preparing' | 'waiting'): void;
    attempt(transport: NetworkTransport): void;
    activity(bytes?: number): void;
    output(): void;
    retry(delayMs: number, kind?: 'transient' | 'connection'): void;
    finish(state: 'completed' | 'failed' | 'cancelled'): void;
}
/** Keeps at most limit records, preferentially evicting terminal records. Handles
 * remain owned by running generators; overflow never loses aggregate accounting.
 * No timers, request content, external identifiers, or errors are retained. */
export declare class NetworkTelemetry {
    private readonly limit;
    private readonly now;
    private readonly rows;
    private readonly startedAt;
    private activeCount;
    private sequence;
    private evicted;
    private readonly totals;
    constructor(limit?: number, now?: () => number);
    begin(transport: NetworkTransport): NetworkRequestHandle;
    snapshot(): NetworkSnapshot;
}
export declare const networkTelemetry: NetworkTelemetry;
export declare function observeNetworkOutput(handle: NetworkRequestHandle, chunk: StreamChunk): void;
/** Generator return/break is cancellation; fallback delegates with the same handle. */
export declare function trackNetwork<T>(telemetry: NetworkTelemetry, transport: NetworkTransport, signal: AbortSignal | undefined, run: (handle: NetworkRequestHandle) => AsyncIterable<T>): AsyncIterable<T>;
