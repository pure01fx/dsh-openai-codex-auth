import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { WebSocketServer } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, ToolCallId, createUserMessage, createToolResultMessage, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeCodexAdapter } from '../src/native-adapter.ts'
import { NativeCodexHttpTransport } from '../src/native-http.ts'
import { NativeCodexWebSocketTransport } from '../src/native-websocket.ts'

const toolSse = await readFile(new URL('./fixtures/responses-tool-reasoning.sse', import.meta.url), 'utf8')
const textSse = await readFile(new URL('./fixtures/responses-text-usage.sse', import.meta.url), 'utf8')
const frames = (sse: string) => sse.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
type WireRequest = { generate?: boolean; input?: Array<Record<string, unknown>>; tools?: unknown[]; previous_response_id?: string }

async function harness(protocol: 'http' | 'websocket', mode: 'replay' | 'error' | 'abort') {
  const requests: WireRequest[] = []
  const warmups: WireRequest[] = []
  const protocols: string[] = []
  let received!: () => void
  const requestReceived = new Promise<void>(resolve => { received = resolve })
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      protocols.push('http')
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as WireRequest)
      received()
      if (mode === 'abort') { res.writeHead(200, {'content-type':'text/event-stream'});res.flushHeaders();return }
      if (mode === 'error') { res.writeHead(400, {'content-type':'application/json'});res.end(JSON.stringify({error:{code:'invalid_request_error',message:'synthetic invalid request'}}));return }
      res.writeHead(200, {'content-type':'text/event-stream'})
      const payload = requests.length === 1 ? toolSse : textSse
      // Actual chunked HTTP response, deliberately splitting SSE frame boundaries.
      res.write(payload.slice(0, 37));res.end(payload.slice(37))
    })
  })
  const ws = new WebSocketServer({server})
  ws.on('connection', socket => {
    socket.on('message', data => {
      const request = JSON.parse(data.toString()) as WireRequest
      if (request.generate === false) {
        warmups.push(request)
        socket.send(JSON.stringify({type:'response.completed',response:{id:'resp_warm'}}));return
      }
      protocols.push('websocket')
      requests.push(request);received()
      if (mode === 'abort') return
      if (mode === 'error') { socket.send(JSON.stringify({type:'error',status_code:400,error:{code:'invalid_request_error',message:'synthetic invalid request'}}));return }
      for (const frame of frames(requests.length === 1 ? toolSse : textSse)) {
        socket.send(frame.slice(0, 17), {fin:false})
        socket.send(frame.slice(17), {fin:true})
      }
    })
  })
  cleanup.push(async () => {
    for (const socket of ws.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => ws.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await new Promise<void>((resolve, reject) => { server.once('error',reject);server.listen(0,'127.0.0.1',resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing loopback address')
  const endpoint = 'http://127.0.0.1:' + address.port + '/backend-api/codex/responses'
  const options = { endpoint, resolveCredential:async()=>({accountId:'synthetic-account',accessToken:'synthetic-only'}), maxRetries:0 }
  const transport = protocol === 'http' ? new NativeCodexHttpTransport(options) : new NativeCodexWebSocketTransport({...options,maxWebSocketReconnects:0})
  if (transport instanceof NativeCodexWebSocketTransport) cleanup.push(()=>transport.dispose())
  const ctx = new Context()
  cleanup.push(()=>ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  new SystemPrompt(ctx,{includeHarnessIdentity:false})
  new ToolRuntime(ctx,{mode:'native'})
  ctx.llm.registerAdapter(['openai-codex'],new NativeCodexAdapter(undefined,transport))
  const executed: string[] = []
  ctx.tools.register(defineTool({
    name:'lookup',description:'Synthetic local lookup',parameters:{key:{type:'string',description:'Lookup key'}},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    execute:async(args,exec)=>{executed.push(String(exec.callId));return 'found:' + args.key},
  }))
  async function turn(messages: Message[], signal?: AbortSignal) {
    const assembler = new BlockAssembler()
    const options: GenerateOptions = {provider:'openai-codex',model:'gpt-test',messages,tools:ctx.tools.schemas(),...(signal === undefined ? {} : {signal})}
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    return assembler
  }
  return {ctx,turn,requests,warmups,protocols,executed,requestReceived}
}
const user = () => createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Look up safe'}]})

describe.each(['http','websocket'] as const)('actual target LLM/tools through local %s', protocol => {
  it('assembles tool IDs, executes the registered tool and replays history to a second response',async()=>{
    const h = await harness(protocol,'replay')
    const messages: Message[] = [user()]
    const first = await h.turn(messages)
    const call = first.blocks().find(block=>block.type==='tool-call')
    expect(call?.type,JSON.stringify({finish:first.finish,requests:h.requests})).toBe('tool-call')
    if (!call || call.type !== 'tool-call') throw new Error('no assembled tool call')
    expect(call.id).toBe(ToolCallId('call_redacted'))
    const result = await h.ctx.tools.execute({name:call.name,arguments:JSON.parse(call.arguments),callId:call.id,signal:new AbortController().signal})
    expect(result.isError).toBe(false)
    expect(h.executed).toEqual(['call_redacted'])
    messages.push(first.message({kind:'model',provider:'openai-codex',model:'gpt-test',replayState:first.replayState}),createToolResultMessage({callId:call.id,content:result.content,isError:result.isError}))
    const second = await h.turn(messages)
    expect(second.blocks().some(block=>block.type==='text' && block.text.length>0)).toBe(true)
    expect(h.requests).toHaveLength(2)
    expect(h.requests[0]?.tools).toHaveLength(1)
    expect(h.protocols).toEqual([protocol,protocol])
    // An ephemeral WS call prewarms the complete history, then sends an empty
    // suffix referencing that prewarm. HTTP always transmits the full history.
    if (protocol === 'websocket') {
      expect(h.warmups).toHaveLength(2)
      expect(h.requests[1]?.previous_response_id).toBe('resp_warm')
    }
    const replay = (protocol === 'websocket' ? h.warmups[1] : h.requests[1])?.input ?? []
    expect(replay).toContainEqual(expect.objectContaining({type:'function_call',call_id:'call_redacted',name:'lookup',arguments:'{"key":"safe"}'}))
    expect(replay).toContainEqual(expect.objectContaining({type:'function_call_output',call_id:'call_redacted',output:'found:safe'}))
    expect(replay).toContainEqual(expect.objectContaining({type:'reasoning',encrypted_content:'encrypted_redacted'}))
  })
  it('preserves permanent upstream failures without executing a tool',async()=>{
    const h = await harness(protocol,'error')
    expect((await h.turn([user()])).finish).toMatchObject({kind:'error',failure:{code:'INVALID_REQUEST',status:400}})
    // A rejected WebSocket request moves that session to HTTP/SSE for the same
    // permanent failure instead of leaving the turn unusable.
    if (protocol === 'websocket') {
      expect(h.requests).toHaveLength(2)
      expect(h.protocols).toEqual(['websocket','http'])
    } else {
      expect(h.requests).toHaveLength(1)
      expect(h.protocols).toEqual(['http'])
    }
    expect(h.executed).toEqual([])
  })
  it('cancels an actual pending connection through the target LLM service',async()=>{
    const h = await harness(protocol,'abort')
    const controller = new AbortController()
    const pending = h.turn([user()],controller.signal)
    await h.requestReceived
    controller.abort()
    expect((await pending).finish).toMatchObject({kind:'aborted',failure:{code:'ABORTED'}})
    expect(h.requests).toHaveLength(1)
    expect(h.protocols).toEqual([protocol])
    expect(h.executed).toEqual([])
  })
})
