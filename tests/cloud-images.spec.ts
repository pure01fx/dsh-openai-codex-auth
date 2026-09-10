import { describe, it, expect } from 'vitest';
import { buildImageGenerationRequest, buildImageEditRequest, validateImageSelection, decodeImageBase64, parseImageResponse, MAX_IMAGE_BYTES } from '../src/cloud-images.js';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=';
describe('cloud image protocol', () => {
  it('defaults without inventing n and forwards configured parameters', () => {
    expect(buildImageGenerationRequest({prompt:'draw'})).toEqual({prompt:'draw',model:'gpt-image-2',quality:'auto',background:'auto',size:'auto'});
    expect(buildImageGenerationRequest({prompt:'draw',n:4,size:'1024x1536',quality:'high',background:'transparent'},'configured')).toMatchObject({n:4,model:'configured',quality:'high',background:'transparent',size:'1024x1536'});
    for (const n of [0,5,1.5,'1']) expect(()=>buildImageGenerationRequest({prompt:'draw',n})).toThrow();
  });
  it('enforces exclusive and bounded sources', () => {
    for(const a of [{}, {images:[]}, {images:[{path:'/a',attachment_id:'a'}]}, {images:[{path:'/a'}],num_last_images_to_include:1}, {num_last_images_to_include:6}]) expect(()=>validateImageSelection(a)).toThrow();
  });
  it('builds ordered JSON edit data without selector fields', () => {
    const images = [png,png].map(x=>({image_url:'data:image/png;base64,'+x}));
    const body = buildImageEditRequest({prompt:'edit',images:[{attachment_id:'b'},{path:'/a.png'}]},images);
    expect(body.images).toEqual(images);
    expect(body).not.toHaveProperty('num_last_images_to_include');
    expect(()=>buildImageEditRequest({prompt:'edit',num_last_images_to_include:2},images.slice(1))).toThrow();
  });
  it('rejects malformed, noncanonical and huge base64 before accepting bytes', () => {
    for(const value of ['', '!!!!', 'Zh==', 'Zg=', 'Zg==' + String.fromCharCode(10), 'a'.repeat(4*Math.ceil(MAX_IMAGE_BYTES/3)+4)]) expect(()=>decodeImageBase64(value)).toThrow();
    expect(()=>decodeImageBase64(png,1)).toThrow();
    expect(()=>parseImageResponse({data:[{b64_json:'YWJj'}]})).toThrow();
  });
  it('validates required u64 timestamps and bounded optional wire metadata', () => {
    const response = { created: 0, data: [{ b64_json: png }] };
    for (const created of [undefined, null, -1, 1.5, '1', Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => parseImageResponse({ ...response, created })).toThrow('created');
    for (const extra of [{ quality: 'ultra' }, { background: {} }, { size: 123 }, { size: 'x'.repeat(65) }]) expect(() => parseImageResponse({ ...response, ...extra })).toThrow();
    for (const generation_id of [5, {}, 'x'.repeat(513)]) expect(() => parseImageResponse({ ...response, data: [{ b64_json: png, generation_id }] })).toThrow('generation_id');
    const result = parseImageResponse({ ...response, quality: null, secret: png, data: [{ b64_json: png, nested: { b64_json: png } }] });
    expect(result.metadata).toEqual({ created: 0 });
    expect(result.images[0].metadata).toEqual({});
    expect(() => buildImageEditRequest({ prompt: 'edit', images: [{ path: '/a' }] }, [{ image_url: 'data:image/jpeg;base64,' + png }])).toThrow('media type');
  });
  it('preserves every result, generation ids and actual parameters without base64', () => {
    const result = parseImageResponse({created:123,quality:'low',size:'512x512',custom:{v:1},data:[{b64_json:png,generation_id:'a',revised_prompt:'one'},{b64_json:png,generation_id:'b'}]},'request');
    expect(result.images.map(x=>x.generation_id)).toEqual(['a','b']);
    expect(result.metadata).toEqual({created:123,quality:'low',size:'512x512',request_id:'request'});
    expect(result.images[0].metadata).toEqual({generation_id:'a'});
    expect(result.images[0].data.length).toBe(Buffer.from(png,'base64').length);
  });
});
