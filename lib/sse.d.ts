export declare const DEFAULT_MAX_SSE_EVENT_BYTES: number;
export interface SseEvent {
    data: string;
    event?: string;
}
export interface ParseSseOptions {
    signal?: AbortSignal;
    onActivity?: () => void;
    maxEventBytes?: number;
}
/** Decode a byte stream into bounded SSE frames. */
export declare function parseSse(stream: ReadableStream<Uint8Array>, options?: ParseSseOptions): AsyncGenerator<SseEvent>;
