import { describe, expect, it } from 'vitest'
import { inspectCloudImages, parseCloudVisionArgs } from '../src/cloud-vision.ts'
import type { NativeCodexModel } from '../src/catalog.ts'
const model: NativeCodexModel = { slug:'gpt-test',displayName:'test',supportedReasoningLevels:[],visibility:'list',supportedInApi:true,priority:0,additionalSpeedTiers:[],serviceTiers:[],inputModalities:['text','image'] }
const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const image = { data,mediaType:'image/png' as const,image_url:'data:image/png;base64,'+data.toString('base64'),width:1,height:1,scaled:false }
function sse(tool = false) { return new Response([
  {type:'response.output_item.done',item:tool ? {type:'function_call',id:'fc_test',call_id:'call_test',name:'codex_web',arguments:'{}'} : {type:'message',id:'msg_test',content:[{type:'output_text',text:'Visible text'}]}},
  {type:'response.completed',response:{id:'resp_test',usage:{input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:0}}}},
].map(row=>'data: '+JSON.stringify(row)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}}) }
const credential={accountId:'acct-test',accessToken:'test-secret'}
describe('explicit cloud vision',()=>{
  it.each([
    {patch:{supportsImageDetailOriginal:true},detail:'original',effective:'original'},
    {patch:{supportsImageDetailOriginal:false},detail:'original',effective:'high'},
    {patch:{useResponsesLite:true},detail:'original',effective:undefined},
    {patch:{},detail:'low',effective:'low'},
  ])('normalizes precision and sends only local images with no tools %j',async({patch,detail,effective})=>{
    let sent:any
    const result=await inspectCloudImages(parseCloudVisionArgs({prompt:'read',images:[{path:'/img.png'}],detail}),{model:{...model,...patch},credential,images:[image],signal:new AbortController().signal,transport:{resolveCredential:async()=>credential,fetch:async(_url,init)=>{sent=JSON.parse(String(init!.body));return sse()}}})
    const msg=sent.input.find((row:any)=>row.type==='message'&&row.role==='user')
    expect(msg.content).toEqual([{type:'input_text',text:'read'},{type:'input_image',image_url:image.image_url,...effective===undefined?{}:{detail:effective}}])
    expect(sent.tools??[]).toEqual([])
    for(const row of sent.input)if(row.type==='additional_tools')expect(row.tools).toEqual([])
    expect(result).toEqual({text:'Visible text',model:'gpt-test',usage:{inputTokens:10,outputTokens:2},images:[{requested_detail:detail,effective_detail:effective??'omitted',width:1,height:1,scaled:false}]})
  })
  it('reports normalized attachment dimensions without claiming original pixels',async()=>{
    const result=await inspectCloudImages(parseCloudVisionArgs({prompt:'read',images:[{attachment_id:'ref'}],detail:'original'}),{model:{...model,supportsImageDetailOriginal:true},credential,images:[{...image,width:512,height:256,scaled:true}],signal:new AbortController().signal,transport:{resolveCredential:async()=>credential,fetch:async()=>sse()}})
    expect(result.images).toEqual([{requested_detail:'original',effective_detail:'original',width:512,height:256,scaled:true}])
  })
  it('rejects nonvisual models before sending a request',async()=>{
    let requests=0
    await expect(inspectCloudImages(parseCloudVisionArgs({prompt:'read',images:[{path:'/a.png'}]}),{model:{...model,inputModalities:['text']},credential,images:[image],signal:new AbortController().signal,transport:{resolveCredential:async()=>credential,fetch:async()=>{requests++;return sse()}}})).rejects.toMatchObject({code:'VISION_UNSUPPORTED'})
    expect(requests).toBe(0)
  })
  it('rejects an unexpected tool request instead of executing recursively',async()=>{
    await expect(inspectCloudImages(parseCloudVisionArgs({prompt:'read',images:[{path:'/a.png'}]}),{model,credential,images:[image],signal:new AbortController().signal,transport:{resolveCredential:async()=>credential,fetch:async()=>sse(true)}})).rejects.toMatchObject({code:'UNSUPPORTED'})
  })
  it.each([{prompt:'',images:[{path:'/a'}]},{prompt:'x',images:[]},{prompt:'x',num_last_images_to_include:1},{prompt:'x',images:[{path:'/a'}],detail:'ultra'},{prompt:'x',images:[{path:'/a'}],tools:[]}])('rejects invalid args %j',args=>{expect(()=>parseCloudVisionArgs(args)).toThrow()})
})
