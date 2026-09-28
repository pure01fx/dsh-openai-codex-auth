import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { chooseCloudModel, recentSearchInput, visibleCloudImages } from '../src/cloud-context.ts'
import type { NativeCodexModel } from '../src/catalog.ts'
const model: NativeCodexModel = { slug: 'catalog-model', displayName: 'Model', inputModalities: ['text','image'], supportedReasoningLevels: [], additionalSpeedTiers: [], serviceTiers: [], visibility: 'list', supportedInApi: true, priority: 0 }
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (text: string) => createAssistantMessage({ source: { provider:'openai-codex', model:model.slug, replayState:{secret:'hidden replay'} }, content:[{type:'text',text},{type:'reasoning',text:'hidden thought'}] })
const image = (id:string) => ({ type:'image' as const, attachment:{ attachmentId:AttachmentId(id),mediaType:'image/png' as const,bytes:12,width:1,height:1 } })
describe('cloud model selection',()=>{
  it('uses explicit, configuration, then current Codex model without guessing',()=>{
    const other={...model,slug:'other'}
    expect(chooseCloudModel({purpose:'search',requested:model.slug,configured:'missing',currentModel:'missing'},[model])).toBe(model)
    expect(chooseCloudModel({purpose:'search',configured:model.slug,currentProvider:'deepseek',currentModel:'deepseek'},[model])).toBe(model)
    expect(chooseCloudModel({purpose:'search',currentProvider:'openai-codex',currentModel:'other'},[model,other])).toBe(other)
    expect(()=>chooseCloudModel({purpose:'search',currentProvider:'deepseek',currentModel:model.slug},[model])).toThrow('cloudTools.searchModel')
    expect(()=>chooseCloudModel({purpose:'vision'},[model])).toThrow('cloudTools.visionModel')
    expect(()=>chooseCloudModel({purpose:'search',requested:'missing',configured:model.slug},[model])).toThrow('unavailable')
  })
  it('prefers exact fast slugs and resolves only missing fast aliases',()=>{
    const exact={...model,slug:model.slug+'-fast'}
    expect(chooseCloudModel({purpose:'search',requested:exact.slug},[model,exact])).toBe(exact)
    expect(chooseCloudModel({purpose:'search',requested:exact.slug},[model])).toBe(model)
    expect(()=>chooseCloudModel({purpose:'search',requested:model.slug+'-fast-fast'},[model])).toThrow()
    expect(()=>chooseCloudModel({purpose:'vision',requested:model.slug},[{...model,inputModalities:['text']}])).toThrow('image input')
  })
})
describe('caller-visible cloud context',()=>{
  it('keeps only last two human texts and visible assistant text in order',()=>{
    const messages=[user('old'),assistant('old answer'),user('first'),createUserMessage({source:{kind:'plugin',plugin:'private'},content:[{type:'text',text:'secret system'}]}),assistant('answer'),user('second'),createToolResultMessage({callId:ToolCallId('hidden'),content:[{type:'text',text:'secret tool'}],isError:false})]
    expect(recentSearchInput(messages)).toEqual([{role:'user',content:'first'},{role:'assistant',content:'answer'},{role:'user',content:'second'}])
    expect(recentSearchInput([assistant('no human')])).toEqual([])
  })
  it('preserves full human text and selects assistant context without broken codepoints',()=>{
    const result=recentSearchInput([user('a'.repeat(100_000)),assistant('😀'.repeat(700)),user('b'),assistant('好'.repeat(400))])
    expect(result.filter(x=>x.role==='assistant').reduce((n,x)=>n+Buffer.byteLength(x.content),0)).toBeLessThanOrEqual(1000)
    expect(result.filter(x=>x.role==='user')).toEqual([{role:'user',content:'a'.repeat(100_000)},{role:'user',content:'b'}])
    expect(JSON.stringify(result)).not.toContain('�')
    const split=recentSearchInput([user('x'),assistant('😀'.repeat(400)),user('y'),assistant('z')])
    expect(JSON.stringify(split)).not.toContain('�')
    expect(Buffer.byteLength(split.filter(x=>x.role==='assistant').map(x=>x.content).join(''))).toBeLessThanOrEqual(1000)
  })
  it('selects chronological user and correlated successful tool images only',()=>{
    const call=ToolCallId('call'),bad=ToolCallId('bad')
    const msgs=[createUserMessage({source:{kind:'user'},content:[image('upload')]}),createUserMessage({source:{kind:'plugin',plugin:'secret'},content:[image('private')]}),createAssistantMessage({source:{provider:'p',model:'m'},content:[image('assistant'),{type:'tool-call',id:call,name:'read_image',arguments:'{}'}]}),createToolResultMessage({callId:call,content:[image('tool')],isError:false}),createToolResultMessage({callId:bad,content:[image('orphan')],isError:false}),createToolResultMessage({callId:call,content:[image('failed')],isError:true}),createUserMessage({source:{kind:'user'},content:[image('new')]} )]
    expect(visibleCloudImages(msgs).map(x=>x.attachmentId)).toEqual(['upload','tool','new'])
  })
})
