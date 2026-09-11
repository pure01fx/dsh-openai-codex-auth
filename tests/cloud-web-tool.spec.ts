import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { ToolRuntime, renderToolsSdk } from '@deepseek-ai/dsh-tools'
import { nativeCodexAuthorityHash, type NativeCodexModel } from '../src/catalog.ts'
import { NativeCodexCloudClient } from '../src/cloud-http.ts'
import { registerCodexWeb } from '../src/cloud-web-tool.ts'
const model: NativeCodexModel={slug:'catalog-model',displayName:'Model',inputModalities:['text','image'],supportedReasoningLevels:[],additionalSpeedTiers:[],serviceTiers:[],visibility:'list',supportedInApi:true,priority:0}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
function setup(options: { account?:string; response?:unknown; messages?:Message[]; config?:{searchModel?:string;searchMode?:'live'|'cached'|'indexed'} }={}) {
  const ctx=new Context()
  ctx.provide('systemPrompt',{tools:()=>()=>{},section:()=>()=>{}} as any)
  new ToolRuntime(ctx)
  let account=options.account??'account-a'
  const sent: {body:any;headers:Headers;url:string}[]=[]
  const client=new NativeCodexCloudClient({resolveCredential:async()=>({accountId:account,accessToken:'oauth-secret'}),fetch:async(url,init)=>{sent.push({url:String(url),headers:new Headers(init!.headers),body:JSON.parse(String(init!.body))});return new Response(JSON.stringify(options.response??{output:'Answer [Source](https://example.test/page) ref_search_1 [0] link',results:[{type:'future',ref_id:'ref_search_1',url:'https://example.test/page',opaque:{n:9}}]}),{headers:{'content-type':'application/json'}})}})
  const catalog={list:async()=>[model],listWithAuthority:async()=>({models:[model],authorityHash:nativeCodexAuthorityHash(account)}),etag:()=>undefined}
  registerCodexWeb(ctx,{client,catalog,config:options.config??{}})
  const messages=options.messages??[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'visible question'}]})]
  const callerCtx=new Context()
  const session={id:'session-id',header:{cwd:'/caller/workspace'},deriveMessages:()=>messages}
  const agent={id:session.id,session,ctx:callerCtx,options:{provider:'openai-codex',model:model.slug+'-fast'}} as any
  let calls=0
  const execute=(args:any={commands:{search_query:[{q:'test'}]}},signal=new AbortController().signal,caller:any=agent)=>ctx.tools.execute({callId:ToolCallId('call-'+(++calls)),name:'codex_web',arguments:args,agent:caller,signal})
  return {ctx,callerCtx,client,catalog,sent,agent,messages,execute,setAccount:(value:string)=>{account=value}}
}
const ok=(result:any)=>{expect(result.isError,JSON.stringify(result)).toBe(false);return result.value as any}
describe('codex_web public ToolRuntime integration',()=>{
  it('returns canonical values and visible clickable sources without OAuth or encrypted output',async()=>{
    const f=setup({response:{output:'Answer [Source](https://example.test/a)',encrypted_output:'secret encrypted',results:[{type:'future',ref_id:'ref_a',url:'https://example.test/a',link_id:3,extra:[1,2]}]}})
    const result=await f.execute()
    const value=ok(result)
    expect(value.results).toEqual([{type:'future',ref_id:'ref_a',url:'https://example.test/a',link_id:3,extra:[1,2]}])
    expect(value).toMatchObject({model:model.slug,truncated:false})
    expect(value.output).toContain('<https://example.test/a>')
    expect(value.output).toMatch(/\[codex_web context: [a-f0-9]{64}\]/)
    expect(result.content).toEqual([{type:'text',text:value.output}])
    expect(JSON.stringify(result)).not.toMatch(/oauth-secret|secret encrypted|account-a/)
    expect(f.sent[0]).toMatchObject({url:'https://chatgpt.com/backend-api/codex/alpha/search',body:{model:model.slug,settings:{external_web_access:true,allowed_callers:['direct']},input:[{type:'message',role:'user',content:[{type:'input_text',text:'visible question'}]}]}})
  })
  it('registers complete command parameter and canonical image schemas for code mode',()=>{
    const f=setup()
    const schema=f.ctx.tools.get('codex_web')!
    const props=(schema.parameters as any).properties
    expect(Object.keys(props.commands.properties)).toEqual(['search_query','image_query','open','click','find','screenshot','finance','weather','sports','time','response_length'])
    expect(props.commands.properties.sports.items.properties.league.enum).toEqual(['nba','wnba','nfl','nhl','mlb','epl','ncaamb','ncaawb','ipl'])
    expect(props.commands.properties.click.items.required).toEqual(['ref_id','id'])
    expect(schema.output.schema.properties!.images!.items!.required).toContain('attachmentId')
    const sdk=renderToolsSdk([{...schema,output:schema.output.schema}])
    expect(sdk).toContain('codex_web:')
    expect(sdk).toContain('images?:')
    expect(sdk).toContain('attachmentId: string')
    expect(sdk).toContain('screenshot?:')
  })
  it('executes all ten operations with the exact wire fields and mode/config precedence',async()=>{
    const f=setup({config:{searchModel:model.slug,searchMode:'cached'}})
    const commands={search_query:[{q:'q',recency:2,domains:['example.test']}],image_query:[{q:'image'}],open:[{ref_id:'https://example.test'}],click:[{ref_id:'https://example.test',id:0}],find:[{ref_id:'https://example.test',pattern:'text'}],screenshot:[{ref_id:'https://example.test/a.pdf',pageno:0}],finance:[{ticker:'X',type:'equity',market:'USA'}],weather:[{location:'City',start:'2026-09-10',duration:2}],sports:[{fn:'schedule',league:'nba',tool:'sports',team:'LAL',num_games:2}],time:[{utc_offset:'+08:00'}],response_length:'long'}
    ok(await f.execute({commands,mode:'indexed',user_location:{country:'US'},image_settings:{max_results:2,caption:true},filters:{blocked_domains:['bad.test']}}))
    expect(f.sent[0]!.body.commands).toEqual(commands)
    expect(f.sent[0]!.body.settings).toEqual({allowed_callers:['direct'],external_web_access:'indexed',user_location:{type:'approximate',country:'US'},image_settings:{max_results:2,caption:true},filters:{blocked_domains:['bad.test']}})
    ok(await f.execute())
    expect(f.sent[1]!.body.settings.external_web_access).toBe(false)
  })
  it('uses stable ids across calls and rejects old account references including after cold reload',async()=>{
    const f=setup()
    const first=await f.execute(); const value=ok(first)
    ok(await f.execute({commands:{open:[{ref_id:'ref_search_1'}]}}))
    expect(f.sent[0]!.body.id).toBe(f.sent[1]!.body.id)
    const history=[createAssistantMessage({source:{provider:'p',model:'m'},content:[{type:'tool-call',id:ToolCallId('saved'),name:'codex_web',arguments:'{}'}]}),createToolResultMessage({callId:ToolCallId('saved'),content:first.content,isError:false})]
    const restored=setup({messages:history})
    ok(await restored.execute({commands:{open:[{ref_id:'ref_search_1'}]}}))
    expect(restored.sent[0]!.body.id).toBe(f.sent[0]!.body.id)
    restored.setAccount('account-b')
    expect((await restored.execute({commands:{open:[{ref_id:'ref_search_1'}]}})).isError).toBe(true)
    ok(await restored.execute())
    expect(restored.sent[1]!.body.id).not.toBe(f.sent[0]!.body.id)
    expect(value.output).not.toContain('account-a')
  })
  it('isolates caller text, supports explicit context, and rejects missing/non-Codex model configuration',async()=>{
    const f=setup({messages:[createUserMessage({source:{kind:'plugin',plugin:'secret'},content:[{type:'text',text:'private context'}]}),createUserMessage({source:{kind:'user'},content:[{type:'text',text:'human'}]}),createAssistantMessage({source:{provider:'p',model:'m',replayState:'hidden replay'},content:[{type:'reasoning',text:'private thought'},{type:'text',text:'visible answer'}]})]})
    ok(await f.execute())
    expect(JSON.stringify(f.sent[0]!.body)).not.toMatch(/private|hidden replay/)
    expect(f.sent[0]!.body.input[1]).toEqual({type:'message',role:'assistant',content:[{type:'output_text',text:'visible answer'}]})
    ok(await f.execute({commands:{time:[{utc_offset:'+00:00'}]},context:'explicit'}))
    expect(f.sent[1]!.body.input).toEqual([{type:'message',role:'user',content:[{type:'input_text',text:'explicit'}]}])
    f.agent.options={provider:'deepseek',model:'deepseek-chat'}
    expect((await f.execute()).isError).toBe(true)
    ok(await f.execute({commands:{time:[{utc_offset:'+00:00'}]},model:model.slug}))
    expect((await f.execute(undefined,undefined,null)).isError).toBe(true)
  })
  it('fails closed for catalog mismatch or missing authority and validates args before network',async()=>{
    const f=setup()
    f.catalog.listWithAuthority=async()=>({models:[model],authorityHash:'wrong'})
    expect((await f.execute()).isError).toBe(true)
    expect(f.sent).toHaveLength(0)
    for(const args of [{commands:{}},{commands:{search_query:[]}},{commands:{screenshot:[{ref_id:'url',pageno:-1}]}},{commands:{sports:[{fn:'schedule',league:'invented'}]}}]) expect((await f.execute(args)).isError).toBe(true)
    expect(f.sent).toHaveLength(0)
  })
  it('attaches known inline image blocks using only caller-scoped service and retains unknown variants',async()=>{
    const inline={type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64'),detail:'original'}
    const unknown={type:'new_image_dto',image_url:'https://example.test/unknown.png',opaque:[1,2]}
    const f=setup({response:{output:'PDF screenshot result',results:[{content:[inline]},unknown]}})
    const ref={attachmentId:AttachmentId('image-test'),mediaType:'image/png',bytes:png.length,width:1,height:1}
    const save=vi.fn(async()=>ref)
    f.ctx.provide('attachments',{saveImage:()=>{throw new Error('wrong root scope')}} as any)
    f.callerCtx.provide('attachments',{saveImage:save} as any)
    const resolveModelInfo=vi.fn(async()=>({inputModalities:['text','image']}))
    f.callerCtx.provide('llm',{resolveModelInfo} as any)
    const result=await f.execute({commands:{screenshot:[{ref_id:'https://example.test/a.pdf',pageno:0}]}})
    const value=ok(result)
    expect(save).toHaveBeenCalledWith({data:png,mediaType:'image/png'})
    expect(value.images).toEqual([ref])
    expect(value.image_output).toBe(true)
    expect(resolveModelInfo).toHaveBeenCalledWith('openai-codex',model.slug+'-fast',expect.any(AbortSignal))
    expect(result.content[1]).toEqual({type:'image',attachment:ref})
    expect(value.results[1]).toEqual(unknown)
    expect(JSON.stringify(result)).not.toContain(png.toString('base64'))
  })
  it.each(['text-only','unknown','missing-service','resolution-error'])('keeps canonical attachments and text without rendering images for %s callers',async(kind)=>{
    const f=setup({config:{searchModel:model.slug},response:{output:'Image result',results:[{type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}]}})
    f.agent.options={provider:'deepseek',model:'deepseek-chat'}
    const ref={attachmentId:AttachmentId('saved-image'),mediaType:'image/png',bytes:png.length,width:1,height:1}
    f.callerCtx.provide('attachments',{saveImage:async()=>ref} as any)
    const resolveModelInfo=vi.fn(async()=>{if(kind==='resolution-error')throw new Error('metadata unavailable');return kind==='unknown'?{}:{inputModalities:['text']}})
    if(kind!=='missing-service')f.callerCtx.provide('llm',{resolveModelInfo} as any)
    f.ctx.provide('llm',{resolveModelInfo:()=>{throw new Error('root service must not be used')}} as any)
    const result=await f.execute();const value=ok(result)
    expect(value.images).toEqual([ref])
    expect(value.image_output).toBe(false)
    expect(value.output).toContain('saved-image')
    expect(result.content).toEqual([{type:'text',text:value.output}])
    expect(f.sent[0]!.body.model).toBe(model.slug)
    if(kind!=='missing-service')expect(resolveModelInfo).toHaveBeenCalledWith('deepseek','deepseek-chat',expect.any(AbortSignal))
  })
  it('propagates cancellation during caller capability resolution',async()=>{
    const f=setup({response:{output:'Image',results:[{type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}]}})
    f.callerCtx.provide('attachments',{saveImage:async()=>({attachmentId:AttachmentId('saved-image'),mediaType:'image/png',bytes:png.length,width:1,height:1})} as any)
    const abort=new AbortController()
    f.callerCtx.provide('llm',{resolveModelInfo:async()=>{abort.abort();throw new Error('cancelled')}} as any)
    expect((await f.execute(undefined,abort.signal)).isError).toBe(true)
  })
  it('preserves links and text when attachments or binary networking are unavailable',async()=>{
    const f=setup({response:{output:'Images',results:[{type:'input_image',image_url:'https://example.test/image.png'},{type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}]}})
    const value=ok(await f.execute({commands:{image_query:[{q:'image'}]}}))
    expect(value.output).toContain('Remote image unavailable')
    expect(value.output).toContain('Inline image unavailable')
    expect(value.output).toContain('<https://example.test/image.png>')
    expect(value.images).toBeUndefined()
    expect(f.sent).toHaveLength(1)
  })
  it('honors cancellation before requests and while cloud response is pending',async()=>{
    const f=setup(); const abort=new AbortController();abort.abort()
    expect((await f.execute(undefined,abort.signal)).isError).toBe(true)
    expect(f.sent).toHaveLength(0)
    const pending=new AbortController()
    vi.spyOn(f.client,'post').mockImplementation(async(_path,_body,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});pending.abort()}))
    expect((await f.execute(undefined,pending.signal)).isError).toBe(true)
  })
  it('bounds opaque results and preserves unknown keys and nested arrays losslessly',async()=>{
    const unknown=JSON.parse('{"__proto__":{"kept":true},"type":"unknown","content":[1,2,3]}')
    const f=setup({response:{output:'large',results:[unknown,...Array.from({length:110},(_,n)=>({n,opaque:'value'}))]}})
    const value=ok(await f.execute())
    expect(value.results).toHaveLength(100)
    expect(value.results[0]).toEqual(unknown)
    expect(value.truncated).toBe(true)
    expect(value.output).toContain('truncated')
    expect(Buffer.byteLength(value.output)).toBeLessThan(1024*1024)
  })
  it('limits image count, removes transferred bytes, and keeps chronological attachment order',async()=>{
    const f=setup({response:{output:'images',results:[{content:Array.from({length:6},()=>({type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}))}]}})
    let count=0
    f.callerCtx.provide('attachments',{saveImage:async()=>({attachmentId:AttachmentId('image-'+(++count)),mediaType:'image/png',bytes:png.length,width:1,height:1})} as any)
    const value=ok(await f.execute())
    expect(value.images.map((x:any)=>x.attachmentId)).toEqual(['image-1','image-2','image-3','image-4'])
    expect(value.output).toContain('limit reached')
    expect(value.output).not.toContain(png.toString('base64'))
  })
  it('requires an actual reference token and a matching session, not a substring or forged user marker',async()=>{
    const f=setup(); const first=await f.execute();ok(first)
    expect((await f.execute({commands:{open:[{ref_id:'ref_search'}]}})).isError).toBe(true)
    const userHistory=setup({messages:[createUserMessage({source:{kind:'user'},content:first.content})]})
    expect((await userHistory.execute({commands:{open:[{ref_id:'ref_search_1'}]}})).isError).toBe(true)
    f.agent.session.id='other-session'
    expect((await f.execute({commands:{open:[{ref_id:'ref_search_1'}]}})).isError).toBe(true)
    expect(f.sent).toHaveLength(1)
  })
  it('fails closed when authority is unavailable and never saves invalid response envelopes',async()=>{
    const f=setup();delete (f.catalog as any).listWithAuthority
    expect((await f.execute()).isError).toBe(true)
    expect(f.sent).toHaveLength(0)
    const malformed=setup({response:{output:null,results:[{type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}]}})
    const save=vi.fn();malformed.callerCtx.provide('attachments',{saveImage:save} as any)
    expect((await malformed.execute()).isError).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })
  it('omits registration when optional tools service is absent',()=>{
    const f=setup()
    expect(()=>registerCodexWeb(new Context(),{client:f.client,catalog:f.catalog,config:{}})).not.toThrow()
  })
})
