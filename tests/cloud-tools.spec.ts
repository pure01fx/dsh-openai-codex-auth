import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolCallId, createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { registerCodexImageTools } from '../src/cloud-tools.ts'
import { NativeCodexCloudClient } from '../src/cloud-http.ts'
import { nativeCodexAuthorityHash } from '../src/catalog.ts'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { execFile } from 'node:child_process'
import sharp from 'sharp'
const cleanup: (()=>Promise<unknown>)[]=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
const credential={accountId:'acct-test',accessToken:'synthetic-secret'}
const model={slug:'gpt-test',displayName:'test',supportedReasoningLevels:[],visibility:'list',supportedInApi:true,priority:0,additionalSpeedTiers:[],serviceTiers:[],inputModalities:['text','image'],supportsImageDetailOriginal:true}
async function harness(options:{services?:boolean;config?:any}={}){
  const root=await mkdtemp(join(tmpdir(),'codex-tools-'));cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const ctx=new Context();cleanup.push(()=>ctx.fiber.dispose())
  new SystemPrompt(ctx,{includeHarnessIdentity:false})
  new ToolRuntime(ctx,{mode:'native'})
  const raw=await sharp({create:{width:8,height:4,channels:4,background:'red'}}).png().toBuffer()
  const posts:{url:string;body:any}[]=[]
  const history:any[]=[]
  const policy={mode:'workspace-write',workspaceRoot:root}
  if(options.services!==false){
    new LocalAttachmentStore(ctx,{dshHome:root})
    ctx.provide('fs',{resolve:async(p:string,o:any)=>resolve(o?.cwd??root,p),processPath:(p:string)=>p,contains:(a:string,b:string)=>!relative(a,b).startsWith('..'),readBytes:async(p:string)=>readFile(p)} as never)
    ctx.provide('sandboxPolicy',{resolve:()=>policy} as never)
    ctx.provide('shell',{sandboxMode:'workspace-write',resolve:(x:any)=>x,run:async(x:any)=>{
      expect(x.sandboxPolicy).toBe(policy)
      // This integration verifies policy forwarding; real enforcement is a separate oracle.
      return new Promise((res,rej)=>{const child=execFile('bash',['-c',x.command],{cwd:x.workdir},err=>err?rej(err):res({exitCode:0}));child.stdin!.end(x.stdin)})
    }} as never)
    ctx.provide('llm',{resolveModelInfo:async()=>model} as never)
  }
  const fetcher:typeof fetch=async(url,init)=>{
    posts.push({url:String(url),body:JSON.parse(String(init!.body))})
    if(String(url).endsWith('/responses'))return new Response([
      {type:'response.output_item.done',item:{type:'message',id:'msg_vision',content:[{type:'output_text',text:'A red rectangle.'}]}},
      {type:'response.completed',response:{id:'resp_vision'}}
    ].map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
    return Response.json({created:1,data:[{b64_json:raw.toString('base64'),generation_id:'gen-test'}]},{headers:{'x-codex-imagegen-request-id':'req-img'}})
  }
  const transport={resolveCredential:async()=>credential,fetch:fetcher}
  registerCodexImageTools(ctx,{client:new NativeCodexCloudClient(transport),catalog:{list:async()=>[model],listWithAuthority:async()=>({models:[model],authorityHash:nativeCodexAuthorityHash(credential.accountId)}),etag:()=>undefined},transport,config:options.config??{}})
  const agent={id:'agent-test',options:{provider:'openai-codex',model:'gpt-test'},ctx,session:{header:{cwd:root},deriveMessages:()=>history}} as any
  const scope=createScope(ctx,agent)
  agent.ctx=scope.ctx
  Object.defineProperty(scope.ctx,'agent',{value:agent,configurable:true})
  cleanup.push(()=>scope.dispose())
  let call=0
  async function execute(name:string,args:any){
    const id=ToolCallId('call-'+ ++call)
    history.push(createAssistantMessage({source:{provider:'openai-codex',model:'gpt-test'},content:[{type:'tool-call',name,id,arguments:JSON.stringify(args)}]}))
    const result=await ctx.tools.execute({name,arguments:args,callId:id,agent,signal:new AbortController().signal})
    if(!result.isError)history.push(createToolResultMessage({callId:id,content:result.content,isError:false}))
    return result
  }
  return {ctx,agent,execute,posts,root,raw,history}
}
describe('registered image tools',()=>{
  it('runs generation → attachment editing → inspection through the actual registry',async()=>{
    const h=await harness()
    const generated=await h.execute('codex_image_generate',{prompt:'red rectangle'})
    expect(generated.isError,JSON.stringify(generated)).toBe(false)
    const value=generated.value as any
    expect(value.created).toBe(1);expect(value.request_id).toBe('req-img')
    expect(await readFile(value.images[0].path)).toEqual(h.raw)
    expect(generated.content.some(x=>x.type==='image')).toBe(true)
    const ref=value.images[0].attachment.attachmentId
    const edited=await h.execute('codex_image_edit',{prompt:'keep red',images:[{attachment_id:ref}]})
    expect(edited.isError,JSON.stringify(edited)).toBe(false)
    const inspected=await h.execute('codex_image_inspect',{prompt:'describe',images:[{path:value.images[0].path}],detail:'original'})
    expect(inspected.isError,JSON.stringify(inspected)).toBe(false)
    expect((inspected.value as any).text).toBe('A red rectangle.')
    expect(h.posts.map(x=>x.url.split('/').pop())).toEqual(['generations','edits','responses'])
    expect(h.posts[1].body.images[0].image_url).toBe('data:image/png;base64,'+h.raw.toString('base64'))
    expect(h.posts[2].body.tools).toBeUndefined()
    expect(h.posts[2].body.input.find((item: { role?: string }) => item.role === 'user').content[1].detail).toBe('original')
  })
  it('reuses successful same-program images before history is materialized',async()=>{
    const h=await harness()
    const call=(name:string,args:any,id:string)=>h.ctx.tools.execute({name,arguments:args,callId:ToolCallId(id),agent:h.agent,signal:new AbortController().signal})
    const first=await call('codex_image_generate',{prompt:'red'},'same-1')
    expect(first.isError,JSON.stringify(first)).toBe(false)
    expect(h.history).toHaveLength(0)
    const second=await call('codex_image_edit',{prompt:'keep red',num_last_images_to_include:1},'same-2')
    expect(second.isError,JSON.stringify(second)).toBe(false)
    h.history.push(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'new turn'}]}))
    const stale=await call('codex_image_edit',{prompt:'keep red',num_last_images_to_include:1},'same-3')
    expect(stale.isError).toBe(true)
    expect(h.posts).toHaveLength(2)
  })
  it('retains canonical attachments without image content for a nonvisual caller',async()=>{
    const h=await harness()
    h.agent.options={provider:'deepseek',model:'text-only'}
    h.ctx.llm.resolveModelInfo=async()=>({...model,inputModalities:['text']})
    const result=await h.execute('codex_image_generate',{prompt:'red'})
    expect(result.isError,JSON.stringify(result)).toBe(false)
    expect((result.value as any).images[0].attachment.attachmentId).toBeTruthy()
    expect((result.value as any).image_output).toBe(false)
    expect(result.content.every(x=>x.type==='text')).toBe(true)
  })
  it('fails before cloud work when optional media services are missing',async()=>{
    const h=await harness({services:false})
    const result=await h.execute('codex_image_generate',{prompt:'red'})
    expect(result.isError).toBe(true);expect(h.posts).toEqual([])
  })
  it('keeps disabled tools unregistered',async()=>{
    const h=await harness({config:{enabled:false}})
    expect((await h.execute('codex_image_generate',{prompt:'x'})).isError).toBe(true)
    expect(h.posts).toEqual([])
  })
  it('rejects hidden attachments, conflicting selectors and missing agent before sending',async()=>{
    const h=await harness()
    expect((await h.execute('codex_image_edit',{prompt:'x',images:[{attachment_id:'foreign'}]})).isError).toBe(true)
    expect((await h.execute('codex_image_edit',{prompt:'x',images:[{path:'/x'}],num_last_images_to_include:1})).isError).toBe(true)
    expect((await h.ctx.tools.execute({name:'codex_image_inspect',arguments:{prompt:'x',images:[{path:'/x'}]},callId:ToolCallId('no-agent'),signal:new AbortController().signal})).isError).toBe(true)
    expect(h.posts).toEqual([])
  })
})
