import { readFile } from 'node:fs/promises'
import * as targetStore from '@deepseek-ai/dsh-client-store'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

// Execute the published target directory classes with the actual target
// snapshot store (including its Zustand/Immer engine), without minifier-name slicing.
const target = new URL('../node_modules/@deepseek-ai/', import.meta.url)
assert.equal(JSON.parse(await readFile(new URL('dsh-client-store/package.json', target), 'utf8')).version, '0.2.0-rc.2')
assert.equal(JSON.parse(await readFile(new URL('dsh-client-ui-model-selection/package.json', target), 'utf8')).version, '0.2.0-rc.2')
const directory = await readFile(new URL('dsh-client-ui-model-selection/lib/client.js', target), 'utf8')
const bridge = await readFile(new URL('../client.js', import.meta.url), 'utf8')
function slice(source: string, start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, 'target 0.2.0-rc.2 oracle markers changed')
  return source.slice(a, b)
}
const directorySource = slice(directory, 'var ModelCatalogDirectory =', '//#region lib/types/client/service.js')
const bridgeSource = slice(bridge, 'const HIDDEN_MODELS_KEY', 'const css =')

describe('published 0.2.0-rc.2 directory and projection store', () => {
  it('filters publication across selection, catalog, config, reload and reconnect; restores lifecycle', async () => {
    await runInNewContext('const _deepseek_ai_dsh_client_store = targetStore;\n' + directorySource + '\n' + bridgeSource + `
      (async () => {
        const storage = new Map([['dsh.openai-codex.hidden-models.v1', '["hidden"]']]);
        window.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
        const groups = [{id:'openai-codex', name:'Codex', models:[{id:'hidden',name:'Hidden'},{id:'visible',name:'Visible'}]},
          {id:'other',name:'Other',models:[{id:'hidden',name:'Other hidden ID'}]}];
        let catalogValue = {default:{provider:'openai-codex',model:'visible'}, groups, failures:[], routableProviders:['openai-codex']};
        let catalogLoads = 0;
        const catalog = new ModelCatalogDirectory({remote:{session:{modelCatalog:async()=>{catalogLoads++;return {ok:true,value:catalogValue}}}}});
        const projected = targetStore.createSnapshotStore({next:null});
        const sessions = {selectModel:async value=>{projected.set({next:{provider:value.provider,model:value.model}});return {ok:true}}};
        const first = new ModelDirectory(sessions,'first',()=>true,catalog,projected,()=>false);
        let active = first;
        const resolver = {live:{directories:new Map([['first',first]])},directoryFor:()=>active};
        const originalFor = resolver.directoryFor, originalSet = first.store.set;
        const dispose = installModelVisibilityBridge({modelDirectories:resolver});
        const ids = d => Array.from(d.store.getSnapshot().groups.find(g=>g.id==='openai-codex')?.models ?? [], m=>m.id);
        let notifications = 0;
        const published = [];
        const unsubscribe = first.store.subscribe(()=>{notifications++;published.push(ids(first))});
        await resolver.directoryFor().load();
        assert.deepEqual(ids(first),['visible']);
        assert.equal(catalogLoads,1);
        await first.select({provider:'openai-codex',model:'hidden'});
        assert.deepEqual(ids(first),['visible']);
        assert.equal(first.store.getSnapshot().current.model,'hidden','hiding must not change selection');
        projected.set({next:{provider:'openai-codex',model:'visible'}});
        assert.deepEqual(ids(first),['visible']);
        catalogValue = {...catalogValue, groups:[{...groups[0],models:[...groups[0].models,{id:'new',name:'New'}]},groups[1]]};
        catalog.store.set({value:catalogValue,status:'ready',error:null});
        assert.deepEqual(ids(first),['visible','new']);
        assert.equal(catalog.store.getSnapshot().value.groups[0].models.length,3,'raw catalog untouched');
        assert.equal(first.store.getSnapshot().groups[1].models[0].id,'hidden','other provider untouched');
        await first.load();
        assert.deepEqual(ids(first),['visible','new']);
        catalog.refresh();
        await catalog.load();
        assert.deepEqual(ids(first),['visible','new']);
        first.resetConnected();
        catalog.resetGeneration();
        await first.load();
        assert.equal(catalogLoads,3);
        assert.deepEqual(ids(first),['visible','new']);
        unsubscribe();
        writeHiddenModels([]);
        assert.deepEqual(ids(first),['hidden','visible','new'],'unhide restores raw catalog after load');
        writeHiddenModels(['hidden','new']);
        assert.deepEqual(ids(first),['visible']);
        active = new ModelDirectory(sessions,'second',()=>true,catalog,targetStore.createSnapshotStore({next:null}),()=>false);
        const secondSet = active.store.set;
        const second = resolver.directoryFor();
        await second.load();
        assert.deepEqual(ids(second),['visible']);
        first.dispose();
        assert.equal(first.store.set,originalSet);
        projected.set({next:{provider:'openai-codex',model:'hidden'}});
        dispose();
        assert.equal(resolver.directoryFor,originalFor);
        assert.equal(second.store.set,secondSet);
        second.dispose();
        const reloaded = new ModelDirectory(sessions,'reload',()=>true,catalog,targetStore.createSnapshotStore({next:null}),()=>false);
        active = reloaded;
        const disposeReload = installModelVisibilityBridge({modelDirectories:resolver});
        await resolver.directoryFor().load();
        assert.deepEqual(ids(reloaded),['visible'],'persisted hiding survives bridge reload');
        disposeReload();reloaded.dispose();
        assert.ok(notifications >= 5);
        assert.ok(published.every(ids=>!ids.includes('hidden')), 'no subscriber may see a hidden row');
      })()
    `, { window: new EventTarget(), CustomEvent, console, queueMicrotask, assert, targetStore })
  })
})
