import { describe, it, expect, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import sharp from 'sharp';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveImageSources, saveImageOutputs, type MediaSourceDependencies, type MediaOutputDependencies } from '../src/cloud-media.js';
import { parseImageResponse } from '../src/cloud-images.js';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=';
const bytes = Buffer.from(png,'base64');
function fixture() {
 const refs = ['a','b','c'].map(attachmentId=>({attachmentId,mediaType:'image/png',bytes:bytes.length,width:1,height:1}));
 const fs = {resolve:vi.fn(async (path:string, opts?:any)=>({path:path.startsWith('.') ? opts.cwd+'/'+path : path})),processPath:vi.fn((t:any)=>t.path),readBytes:vi.fn(async()=>bytes),contains:vi.fn(()=>true)};
 const attachments = {validateImage:vi.fn(async()=>{}),readImage:vi.fn(async(ref:any)=>({ref,data:bytes})),saveImage:vi.fn(async()=>({...refs[0],bytes:10,width:1,height:1,originalDimensions:{width:2,height:2}}))};
 const shell = {sandboxMode:'workspace-write',resolve:vi.fn(x=>x),execute:vi.fn(async()=>({result:async()=>({exitCode:0,aborted:false,timedOut:false})}))};
 const deps = {fs,attachments,shell,policy:{mode:'workspace-write',workspaceRoot:'/workspace'},workspace:'/workspace',visibleImages:refs};
 return {deps,source:deps as unknown as MediaSourceDependencies,output:deps as unknown as MediaOutputDependencies};
}
describe('scoped cloud media',()=>{
 it('uses real DSH decode for all supported formats, EXIF pixels and corrupt rasters',async()=>{
  const home=await mkdtemp(join(tmpdir(),'codex-media-')); const ctx=new Context();
  const attachments=new LocalAttachmentStore(ctx,{dshHome:home});
  try {
   const {source,deps}=fixture(); source.attachments=attachments;
   for(const format of ['png','jpeg','webp','gif'] as const) {
    const data=await sharp({create:{width:7,height:3,channels:3,background:'#446688'}}).toFormat(format).toBuffer();
    deps.fs.readBytes.mockResolvedValueOnce(data);
    const [image]=await resolveImageSources({images:[{path:'/original.'+format}]},source);
    expect({width:image.width,height:image.height,scaled:image.scaled,data:image.data}).toEqual({width:7,height:3,scaled:false,data});
   }
   const oriented=await sharp({create:{width:7,height:3,channels:3,background:'#446688'}}).withMetadata({orientation:6}).jpeg().toBuffer();
   deps.fs.readBytes.mockResolvedValueOnce(oriented);
   expect((await resolveImageSources({images:[{path:'/oriented.jpg'}]},source))[0]).toMatchObject({width:7,height:3,data:oriented});
   const ref=await attachments.saveImage({data:oriented,mediaType:'image/jpeg'});
   source.visibleImages=[ref];
   expect((await resolveImageSources({images:[{attachment_id:ref.attachmentId}]},source))[0]).toMatchObject({width:3,height:7});
   const valid=await sharp({create:{width:7,height:3,channels:3,background:'#446688'}}).png().toBuffer();
   deps.fs.readBytes.mockResolvedValueOnce(valid.subarray(0,40));
   await expect(resolveImageSources({images:[{path:'/broken.png'}]},source)).rejects.toThrow();
  } finally { await rm(home,{recursive:true,force:true}); }
 });
 it('writes exact originals with private permissions and reuses real normalized previews',async()=>{
  const home=await mkdtemp(join(tmpdir(),"codex media '$()-")); const ctx=new Context();
  const attachments=new LocalAttachmentStore(ctx,{dshHome:join(home,'store'),normalizedImageMaxDimension:4});
  try {
   const {output,source,deps}=fixture(); output.workspace=home; output.attachments=attachments;
   deps.shell.execute.mockImplementation(async (request:any)=>await new Promise<any>((resolve,reject)=>{
    const child=spawn('bash',['-c',request.command],{cwd:request.workdir,stdio:['pipe','ignore','pipe']});
    child.on('error',reject); child.on('close',exitCode=>resolve({result:async()=>({exitCode,aborted:false,timedOut:false})})); child.stdin.end(request.stdin);
   }));
   const original=await sharp({create:{width:8,height:4,channels:3,background:'#446688'}}).png().toBuffer();
   const result=await saveImageOutputs(parseImageResponse({created:1,data:[{b64_json:original.toString('base64')}]}),output);
   expect(await readFile(result.images[0].path)).toEqual(original);
   if(process.platform!=='win32') expect((await stat(result.images[0].path)).mode & 0o777).toBe(0o600);
   expect(result.images[0]).toMatchObject({width:8,height:4,bytes:original.length,preview:{width:4,height:2,scaled:true}});
   source.attachments=attachments; source.visibleImages=[result.images[0].attachment];
   expect((await resolveImageSources({num_last_images_to_include:1},source))[0]).toMatchObject({width:4,height:2,scaled:true});
  } finally { await rm(home,{recursive:true,force:true}); }
 });
 it('preserves explicit order and recent chronological order',async()=>{
  const {source}=fixture();
  expect((await resolveImageSources({images:[{attachment_id:'c'},{attachment_id:'a'}]},source)).map(x=>x.attachment?.attachmentId)).toEqual(['c','a']);
  expect((await resolveImageSources({num_last_images_to_include:2},source)).map(x=>x.attachment?.attachmentId)).toEqual(['b','c']);
  await expect(resolveImageSources({num_last_images_to_include:4},source)).rejects.toThrow('Not enough');
 });
 it('denies cross-session references before reads and propagates filesystem denial',async()=>{
  const {source,deps}=fixture();
  await expect(resolveImageSources({images:[{attachment_id:'other-session'}]},source)).rejects.toThrow('not visible');
  expect(deps.attachments.readImage).not.toHaveBeenCalled();
  deps.fs.readBytes.mockRejectedValueOnce(new Error('FS_DENIED'));
  await expect(resolveImageSources({images:[{path:'/denied.png'}]},source)).rejects.toThrow('FS_DENIED');
  expect(deps.fs.readBytes).toHaveBeenCalledWith({path:'/denied.png'},undefined,Number.MAX_SAFE_INTEGER);
  await expect(resolveImageSources({images:[{path:'relative.png'}]},source)).rejects.toThrow('absolute');
 });
 it('retains original path inputs and reports normalized attachment scaling',async()=>{
  const {source}=fixture();
  source.visibleImages[0].originalDimensions={width:2,height:2};
  const result=await resolveImageSources({images:[{path:'/original.png'},{attachment_id:'a'}]},source);
  expect(result[0]).toMatchObject({path:'/original.png',scaled:false,data:bytes,width:1,height:1});
  expect(result[1]).toMatchObject({scaled:true,width:1,height:1});
 });
 it('rejects inconsistent returned refs and encoded metadata',async()=>{
  for (const patch of [{attachmentId:'other'}, {bytes:bytes.length+1}, {width:2}, {mediaType:'image/jpeg'}]) {
   const {source,deps}=fixture();
   deps.attachments.readImage.mockImplementationOnce(async(ref:any)=>({ref:{...ref,...patch},data:bytes}));
   await expect(resolveImageSources({images:[{attachment_id:'a'}]},source)).rejects.toThrow('metadata');
  }
  const {source,deps}=fixture();
  source.visibleImages[0].width=2;
  await expect(resolveImageSources({images:[{attachment_id:'a'}]},source)).rejects.toThrow('dimensions');
  deps.attachments.readImage.mockResolvedValueOnce({ref:source.visibleImages[1] as any,data:bytes.subarray(0,10)});
  await expect(resolveImageSources({images:[{attachment_id:'b'}]},source)).rejects.toThrow('metadata');
 });
 it('preserves remote Windows paths and lets the backend resolve output children',async()=>{
  const {source,output,deps}=fixture();
  const windows=String.raw`C:\workspace\image.png`;
  expect((await resolveImageSources({images:[{path:windows}]},source))[0].path).toBe(windows);
  output.workspace=String.raw`C:\workspace`;
  const result=await saveImageOutputs(parseImageResponse({created:1,data:[{b64_json:png}]}),output);
  expect(deps.fs.resolve).toHaveBeenCalledWith(expect.stringMatching(/^\.dsh\/codex-images\//),{cwd:output.workspace});
  expect(deps.shell.resolve.mock.calls[0][0].workdir).toBe(output.workspace);
  expect(result.images[0].path.startsWith(output.workspace)).toBe(true);
 });
 it('honors cancellation before reads and after image admission',async()=>{
  const {source,deps}=fixture(); const abort=new AbortController(); source.signal=abort.signal;
  deps.attachments.validateImage.mockImplementationOnce(async()=>{abort.abort(new Error('cancelled'));});
  await expect(resolveImageSources({images:[{path:'/original.png'}]},source)).rejects.toThrow('cancelled');
  deps.fs.readBytes.mockClear();
  await expect(resolveImageSources({images:[{path:'/original.png'}]},source)).rejects.toThrow('cancelled');
  expect(deps.fs.readBytes).not.toHaveBeenCalled();
 });
 it('saves ALL original bytes with caller policy and distinct previews',async()=>{
  const {output,deps}=fixture();
  const result=await saveImageOutputs(parseImageResponse({created:1,data:[{b64_json:png,generation_id:'one'},{b64_json:png,generation_id:'two'}]}),output);
  expect(result.images).toHaveLength(2);
  expect(result.images[0]).toMatchObject({bytes:bytes.length,width:1,height:1,generation_id:'one',attachment:{bytes:10},preview:{bytes:10,scaled:true,width:1}});
  expect(result.images[0].path).toMatch(/^[/]workspace[/].dsh[/]codex-images[/].+[.]png$/);
  expect(deps.shell.resolve.mock.calls[0][0]).toMatchObject({stdin:png,sandboxPolicy:deps.policy,workdir:'/workspace'});
  expect(deps.shell.resolve.mock.calls[0][0].command).not.toContain(png);
  expect(deps.attachments.saveImage).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain(png);
 });
 it('does not publish previews on denied original writes or escaped paths',async()=>{
  const {output,deps}=fixture();
  const parsed=parseImageResponse({created:1,data:[{b64_json:png}]});
  deps.fs.contains.mockReturnValueOnce(false);
  await expect(saveImageOutputs(parsed,output)).rejects.toThrow('escapes');
  expect(deps.shell.execute).not.toHaveBeenCalled();
  deps.shell.execute.mockResolvedValueOnce({result:async()=>({exitCode:1,aborted:false,timedOut:false})});
  await expect(saveImageOutputs(parsed,output)).rejects.toThrow('policy');
  expect(deps.attachments.saveImage).not.toHaveBeenCalled();
 });
 it('validates the whole batch before starting artifact writes',async()=>{
  const {output,deps}=fixture();
  deps.attachments.validateImage.mockRejectedValueOnce(new Error('invalid raster'));
  await expect(saveImageOutputs(parseImageResponse({created:1,data:[{b64_json:png}]}),output)).rejects.toThrow('invalid raster');
  expect(deps.shell.execute).not.toHaveBeenCalled();
 });
});