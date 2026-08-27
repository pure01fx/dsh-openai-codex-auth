/** Native OpenAI Codex OAuth login for DeepSeek Harness. */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type IncomingMessage } from 'node:http';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
/** Persisted OAuth credential. */
export interface OpenAICodexCredential {
    access: string;
    refresh: string;
    expires: number;
    accountId: string;
}
/** Plugin configuration. */
export interface Config {
    path?: string;
    dshHome?: string;
    nativeAdapter?: boolean;
    nativeWebSocket?: boolean;
}
interface UsageWindow {
    usedPercent: number;
    windowSeconds?: number;
    resetAt?: number;
}
interface UsageSummary {
    planType?: string;
    primary?: UsageWindow;
    secondary?: UsageWindow;
    limitReached?: boolean;
    resetCredits?: number;
    fetchedAt: number;
}
interface WebRuntimeValues {
    lanAddresses: string[];
    trustedHosts: string[];
}
interface DeviceAuthorization {
    deviceAuthId: string;
    userCode: string;
    intervalSeconds: number;
    expiresAt: number;
}
interface DeviceTokenCode {
    authorizationCode: string;
    codeVerifier: string;
}
interface ParsedDevicePoll {
    status: 'pending' | 'slow_down' | 'complete' | 'failed';
    value?: DeviceTokenCode;
    message?: string;
}
interface TokenResponse {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
}
declare function parseTokenResponse(value: TokenResponse | null, previous?: OpenAICodexCredential): OpenAICodexCredential;
/** Reduce the OpenAI response to the stable fields displayed by the Web card. */
export declare function normalizeUsage(value: unknown): UsageSummary;
declare function parseAuthority(authority: string | undefined): URL | undefined;
declare function isLoopbackHostname(hostname: string): boolean;
declare function isTrustedHost(authority: string | undefined, trustedHosts: readonly string[]): boolean;
declare function isTrustedBrowserRequest(request: IncomingMessage, trustedHosts: readonly string[]): boolean;
declare function browserCallbackUrl(authority: string | undefined, _fallbackPort: number): string | undefined;
declare function callbackHostMatches(authority: string | undefined, redirectUri: string): boolean;
declare function startDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization>;
declare function parseDevicePollResponse(response: Response): Promise<ParsedDevicePoll>;
declare function pollDeviceAuthorization(device: DeviceAuthorization, signal?: AbortSignal): Promise<DeviceTokenCode>;
export declare const internals: {
    parseTokenResponse: typeof parseTokenResponse;
    parseAuthority: typeof parseAuthority;
    isLoopbackHostname: typeof isLoopbackHostname;
    isTrustedHost: typeof isTrustedHost;
    isTrustedBrowserRequest: typeof isTrustedBrowserRequest;
    browserCallbackUrl: typeof browserCallbackUrl;
    callbackHostMatches: typeof callbackHostMatches;
    startDeviceAuthorization: typeof startDeviceAuthorization;
    parseDevicePollResponse: typeof parseDevicePollResponse;
    pollDeviceAuthorization: typeof pollDeviceAuthorization;
};
declare module '@deepseek-ai/cordis' {
    interface Context {
        openaiCodexAuth: OpenAICodexAuth;
        webServer: WebServer;
        webRuntime: WebRuntimeValues;
    }
}
/** DSH service providing device-code/browser login, logout, and automatically refreshed bearer tokens. */
export declare class OpenAICodexAuth extends Service {
    static Config: z<Config>;
    static inject: string[];
    private readonly filename;
    private readonly csrf;
    private usageCache;
    private usageError;
    private usageRefresh;
    private usageGeneration;
    private readonly codexTurns;
    private loginFlow;
    private startingDevice;
    private startingBrowser;
    private lastLoginError;
    constructor(ctx: Context, config: Config);
    private markCodexTurn;
    private consumeCodexTurn;
    private performUsageRefresh;
    private refreshUsage;
    private assertCredentialWritable;
    private publishCredentialToken;
    private restorePublishedCredential;
    private publicationChangedError;
    private failAfterPublicationRollback;
    private commitCredential;
    private resolveManagedCredentialLocked;
    /** Return a valid managed bearer token, refreshing and persisting it when near expiry. */
    bearerToken(signal?: AbortSignal): Promise<string | undefined>;
    private externalNativeCredential;
    private resolveNativeCredential;
    private nativeRecoveryError;
    private recoverNativeCredential;
    private finishCredential;
    private finishAuthorizationCode;
    private settleFlow;
    private beginDeviceLogin;
    private createDeviceLogin;
    private beginBrowserLogin;
    private createBrowserLogin;
    private cancelLogin;
    private logout;
    private status;
    private fetchUsage;
    private write;
    private sendJson;
    private sendText;
    private trustedManagementRequest;
    private requireCsrf;
    private handleStatus;
    private handleDeviceStart;
    private handleBrowserStart;
    private handleBrowserPrepare;
    private handleBrowserComplete;
    private handleCallback;
    private handleCancel;
    private handleLogout;
}
export default OpenAICodexAuth;
