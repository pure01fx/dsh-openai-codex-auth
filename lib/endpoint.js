/** Shared credential-bearing endpoint validation for catalog, HTTP, and WebSocket. */
import { isIP } from 'node:net';
import { LlmError } from '@deepseek-ai/dsh-llm';
function invalid(message, cause) {
    return new LlmError(message, 'INVALID_ARGS', cause === undefined ? undefined : { cause });
}
function loopback(hostname) {
    const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1) : hostname;
    const family = isIP(unbracketed);
    if (family === 4)
        return unbracketed.split('.')[0] === '127';
    return family === 6 && unbracketed === '::1';
}
/** Validate authority, identity components, and TLS before credentials are attached. */
export function nativeCodexEndpoint(endpoint, allowWebSocketProtocols = false) {
    let url;
    try {
        url = new URL(endpoint);
    }
    catch (error) {
        throw invalid('native Codex endpoint is invalid', error);
    }
    if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
        throw invalid('native Codex endpoint contains forbidden identity');
    }
    const local = loopback(url.hostname);
    if (url.hostname !== 'chatgpt.com' && !local) {
        throw invalid('native Codex endpoint authority is unsupported');
    }
    const secure = url.protocol === 'https:' || (allowWebSocketProtocols && url.protocol === 'wss:');
    const localPlaintext = local && (url.protocol === 'http:'
        || (allowWebSocketProtocols && url.protocol === 'ws:'));
    if (!secure && !localPlaintext) {
        throw invalid('native Codex plaintext endpoint must be loopback');
    }
    return url;
}
