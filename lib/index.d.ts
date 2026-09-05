/** Native OpenAI Codex OAuth login for DeepSeek Harness. */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type IncomingMessage } from 'node:http';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import { CODEX_PROVIDER } from './native-adapter.js';
export { CODEX_PROVIDER, NATIVE_CODEX_PROVIDER } from './native-adapter.js';
export { normalizeUsage } from './usage.js';
export { CODEX_CLIENT_VERSION, TRACKED_CODEX_COMMIT, TRACKED_CODEX_RELEASE, TRACKED_CODEX_REPOSITORY, } from './upstream.js';
/** Persisted OAuth credential for one ChatGPT account. */
export interface OpenAICodexCredential {
    access: string;
    refresh: string;
    expires: number;
    accountId: string;
    email?: string;
}
/** Current multi-account credential document. */
export interface OpenAICodexCredentialDocument {
    version: 2;
    currentAccountId: string | null;
    accounts: OpenAICodexCredential[];
}
interface ParsedCredentialDocument {
    document: OpenAICodexCredentialDocument;
    migrated: boolean;
}
/** Plugin configuration. */
export interface Config {
    path?: string;
    dshHome?: string;
    nativeAdapter?: boolean;
    nativeCompatibilityRoute?: boolean;
    nativeWebSocket?: boolean;
}
interface WebRuntimeValues {
    lanAddresses: string[];
    trustedHosts: string[];
}
export type CodexRouteOwner = 'native' | 'external' | 'unregistered';
export type NativeCodexRouteTransport = 'websocket-v2' | 'http-sse';
/** Host-observed ownership of the production Codex provider route. */
export interface CodexRouteStatus {
    provider: typeof CODEX_PROVIDER;
    owner: CodexRouteOwner;
    active: boolean;
    registeredName?: string;
    transport?: NativeCodexRouteTransport;
    compatibilityRoute: {
        configured: boolean;
        active: boolean;
    };
}
interface NativeRouteConfig {
    nativeAdapter: boolean;
    nativeCompatibilityRoute: boolean;
    nativeWebSocket: boolean;
}
interface RouteRuntime {
    listProviders(): Array<{
        id: string;
        name: string;
    }>;
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
declare function parseCredentialDocument(text: string, filename: string): ParsedCredentialDocument;
declare function currentCredential(document: OpenAICodexCredentialDocument | undefined): OpenAICodexCredential | undefined;
declare function parseAuthority(authority: string | undefined): URL | undefined;
declare function isLoopbackHostname(hostname: string): boolean;
declare function isTrustedHost(authority: string | undefined, trustedHosts: readonly string[]): boolean;
declare function isTrustedBrowserRequest(request: IncomingMessage, trustedHosts: readonly string[]): boolean;
declare function browserCallbackUrl(authority: string | undefined, _fallbackPort: number): string | undefined;
declare function callbackHostMatches(authority: string | undefined, redirectUri: string): boolean;
declare function startDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization>;
declare function parseDevicePollResponse(response: Response): Promise<ParsedDevicePoll>;
declare function pollDeviceAuthorization(device: DeviceAuthorization, signal?: AbortSignal): Promise<DeviceTokenCode>;
declare function resolveCodexRouteStatus(config: NativeRouteConfig, llm: RouteRuntime | undefined): CodexRouteStatus;
export declare const internals: {
    parseTokenResponse: typeof parseTokenResponse;
    parseCredentialDocument: typeof parseCredentialDocument;
    currentCredential: typeof currentCredential;
    parseAuthority: typeof parseAuthority;
    isLoopbackHostname: typeof isLoopbackHostname;
    isTrustedHost: typeof isTrustedHost;
    isTrustedBrowserRequest: typeof isTrustedBrowserRequest;
    browserCallbackUrl: typeof browserCallbackUrl;
    callbackHostMatches: typeof callbackHostMatches;
    startDeviceAuthorization: typeof startDeviceAuthorization;
    parseDevicePollResponse: typeof parseDevicePollResponse;
    pollDeviceAuthorization: typeof pollDeviceAuthorization;
    resolveCodexRouteStatus: typeof resolveCodexRouteStatus;
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
    private readonly routeConfig;
    private readonly csrf;
    private usageCache;
    private usageAccountId;
    private responseUsage;
    private credentialAccountId;
    private usageError;
    private usageRefresh;
    private usageGeneration;
    private accountUsageRequestGeneration;
    private readonly accountUsageCredentialRefreshes;
    private directUsageSequence;
    private directUsageAccountId;
    private usageHasDirectDefault;
    private readonly codexTurns;
    private loginFlow;
    private startingDevice;
    private startingBrowser;
    private lastLoginError;
    constructor(ctx: Context, config: Config);
    private setCredentialAccount;
    private acceptResponseUsage;
    private acceptRateLimits;
    private markCodexTurn;
    private consumeCodexTurn;
    private performUsageRefresh;
    private refreshUsage;
    private assertCredentialWritable;
    private publishCredentialToken;
    private restorePublishedCredential;
    private publicationChangedError;
    private failAfterPublicationRollback;
    private commitDocument;
    private upsertCurrentCredential;
    private commitCredential;
    /** Return the current managed bearer token, refreshing and migrating it when needed. */
    bearerToken(signal?: AbortSignal): Promise<string | undefined>;
    private managedCredential;
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
    private resetCurrentAccountState;
    private setCurrentAccount;
    private logoutAttempt;
    private logout;
    private status;
    private accountRefreshJournalFilename;
    private readAccountRefreshJournal;
    private writeAccountRefreshJournal;
    private clearAccountRefreshJournal;
    private removeDeadFileLock;
    private withAccountRefreshLock;
    private withAccountRefreshLocks;
    private reconcileAccountRefreshJournal;
    private refreshManagedAccount;
    private persistAccountUsageCredential;
    private refreshAccountUsageCredential;
    private accountUsageCredential;
    private accountUsages;
    private fetchUsage;
    private write;
    private sendJson;
    private sendText;
    private trustedManagementRequest;
    private requireCsrf;
    private handleStatus;
    private handleAccountUsage;
    private handleDeviceStart;
    private handleBrowserStart;
    private handleBrowserPrepare;
    private handleBrowserComplete;
    private handleCallback;
    private handleCancel;
    private accountIdBody;
    private handleSetCurrentAccount;
    private handleAccountLogout;
    private handleLogout;
}
export default OpenAICodexAuth;
