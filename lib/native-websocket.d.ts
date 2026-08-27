import { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { NativeCodexTransport, NativeCodexTransportMode } from './native-adapter.js';
import { type NativeCodexHttpOptions } from './native-http.js';
import { type NativeCodexWebSocketFactory } from './native-websocket-socket.js';
export interface NativeCodexWebSocketTransportOptions extends NativeCodexHttpOptions {
    webSocketFactory?: NativeCodexWebSocketFactory;
    webSocketConnectTimeoutMs?: number;
    webSocketIdleTimeoutMs?: number;
    maxWebSocketFrameBytes?: number;
    maxWebSocketSessions?: number;
    webSocketSessionIdleMs?: number;
    maxWebSocketReconnects?: number;
}
/** Prefer WebSocket v2; once safe retries exhaust, keep that DSH session on HTTP. */
export declare class NativeCodexWebSocketTransport implements NativeCodexTransport {
    private readonly options;
    private readonly http;
    private readonly factory;
    private readonly sessions;
    private readonly connectTimeoutMs;
    private readonly idleTimeoutMs;
    private readonly maxFrameBytes;
    private readonly maxSessions;
    private readonly sessionIdleMs;
    private readonly maxReconnects;
    private readonly active;
    private disposed;
    constructor(options: NativeCodexWebSocketTransportOptions);
    private closeEntry;
    private prune;
    private entry;
    private assertFastAuthority;
    private headers;
    private ensureSocket;
    private receive;
    private exchange;
    private attempt;
    stream(generation: GenerateOptions, mode?: NativeCodexTransportMode): AsyncIterable<StreamChunk>;
    dispose(): void;
}
