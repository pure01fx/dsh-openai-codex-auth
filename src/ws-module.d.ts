declare module 'ws' {
  import { EventEmitter } from 'node:events'
  import type { IncomingMessage } from 'node:http'

  interface ClientOptions {
    headers?: Record<string, string>
    handshakeTimeout?: number
    maxPayload?: number
    perMessageDeflate?: boolean
  }

  export default class WebSocket extends EventEmitter {
    static readonly OPEN: number
    static readonly CLOSED: number
    readonly readyState: number
    constructor(url: string, options?: ClientOptions)
    send(data: string, callback?: (error?: Error) => void): void
    close(code?: number, reason?: string): void
    terminate(): void
    on(event: 'open', listener: () => void): this
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'unexpected-response', listener: (request: unknown, response: IncomingMessage) => void): this
    on(event: 'upgrade', listener: (response: IncomingMessage) => void): this
  }
}
