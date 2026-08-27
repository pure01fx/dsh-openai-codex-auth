export type NativeCodexWebSocketFrame = {
    type: 'text';
    text: string;
} | {
    type: 'close';
    code: number;
    reason: string;
};
export interface NativeCodexWebSocket {
    readonly responseHeaders: Readonly<Record<string, string>>;
    send(text: string, signal?: AbortSignal): Promise<void>;
    receive(signal?: AbortSignal): Promise<NativeCodexWebSocketFrame>;
    close(): void;
}
export interface NativeCodexWebSocketConnectOptions {
    url: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
    connectTimeoutMs?: number;
    maxFrameBytes?: number;
}
export interface NativeCodexWebSocketFactory {
    connect(options: NativeCodexWebSocketConnectOptions): Promise<NativeCodexWebSocket>;
}
export declare function nativeCodexWebSocketUrl(endpoint: string): string;
export declare class NodeNativeCodexWebSocketFactory implements NativeCodexWebSocketFactory {
    connect(options: NativeCodexWebSocketConnectOptions): Promise<NativeCodexWebSocket>;
}
