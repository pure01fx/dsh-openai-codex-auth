export interface NativeCodexWebSocketRequestPlan {
    payload: Record<string, unknown>;
    incremental: boolean;
    previousResponseId?: string;
}
/** One socket chain. Reset it whenever the socket reconnects or a request fails. */
export declare class NativeCodexWebSocketSessionState {
    private completed;
    private pending;
    plan(request: Record<string, unknown>, allowEmptySuffix?: boolean): NativeCodexWebSocketRequestPlan;
    prewarm(request: Record<string, unknown>): NativeCodexWebSocketRequestPlan;
    complete(responseId: string, outputItems: readonly Record<string, unknown>[]): void;
    reset(): void;
}
