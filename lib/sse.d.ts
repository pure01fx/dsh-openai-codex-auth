export interface SseEvent {
    data: string;
    event?: string;
}
export interface ParseSseOptions {
    signal?: AbortSignal;
    onActivity?: () => void;
    onBytes?: (bytes: number) => void;
}
/** Decode a byte stream into SSE frames. */
export declare function parseSse(stream: ReadableStream<Uint8Array>, options?: ParseSseOptions): AsyncGenerator<SseEvent>;
