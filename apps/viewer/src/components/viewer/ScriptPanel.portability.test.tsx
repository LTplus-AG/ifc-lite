/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/download-capture.js';
import 'fake-indexeddb/auto';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { LocalBackend } from '@/sdk/local-backend';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { loadSavedScripts } from '@/lib/scripts/persistence';
import { useViewerStore } from '@/store';
import { cleanup, render, click, waitFor } from '@/test/render';
import { ScriptPanel } from './ScriptPanel';
const original = useViewerStore.getState();
const sdk = createBimContext({ backend: new LocalBackend(useViewerStore) });
const host = new ExtensionHostService({ sdk });
after(async () => { await host.dispose(); });
const originalFetch = globalThis.fetch;
const code = '// portable IFC query\nconsole.log(bim.query.byType("IfcWall").length)';
function mounted() { return render(<BimReactContext.Provider value={sdk}><ExtensionHostContext.Provider value={host}><ScriptPanel /></ExtensionHostContext.Provider></BimReactContext.Provider>); }
beforeEach(() => { globalThis.fetch = (() => Promise.reject(new Error('external network disabled in native portability test'))) as typeof fetch; localStorage.clear(); useViewerStore.setState({ savedScripts: [], activeScriptId: null, scriptEditorDirty: false, chatPanelVisible: false, scriptExecutionState: 'idle' }); act(() => { useViewerStore.getState().createScript('Original IFC query', code); }); });
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; useViewerStore.setState(original); localStorage.clear(); });
test('#7258 native ScriptPanel exposes saved-script file export', () => {
 const ui = mounted(); assert.ok(ui.querySelector('button[aria-label="Export saved script"]'), 'actual native saved script needs its direct file export control');
});
test('#7258 native ScriptPanel exposes script file import without running code', () => {
 const ui = mounted(); assert.ok(ui.querySelector('input[type="file"][aria-label="Import script file"]'), 'actual native saved-script library needs its direct file import control');
 assert.equal(useViewerStore.getState().scriptExecutionState, 'idle');
});
test('#7258 original native script Save and reload retain full code independently of portability', () => {
 const script = useViewerStore.getState().savedScripts[0]; assert.ok(script);
 assert.deepEqual(loadSavedScripts().find(row => row.id === script.id), script); assert.equal(script.code, code);
});

function choose(ui: HTMLElement, content: string, read?: () => Promise<string>) {
 const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
 const file = new File([content], 'query.ifc-script.json', { type: 'application/json' });
 if (read) Object.defineProperty(file, 'text', { value: read });
 act(() => { Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
async function exported(ui: HTMLElement) {
 const blobs: Blob[] = []; const capture = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => { assert.ok(value instanceof Blob); blobs.push(value); return 'blob:script-portability'; });
 try { const button = ui.querySelector<HTMLButtonElement>('button[aria-label="Export saved script"]'); assert.ok(button); click(button); assert.equal(blobs.length, 1); return await blobs[0].text(); } finally { capture.mock.restore(); }
}
test('#7258 actual download/import retains complete native code and metadata under a fresh local identity, without replacing dirty editor', async () => {
 const original = useViewerStore.getState().savedScripts[0]; const ui = mounted(); const text = await exported(ui);
 act(() => useViewerStore.getState().setScriptEditorContent('// unsaved local edit'));
 choose(ui, text); await waitFor(() => useViewerStore.getState().savedScripts.length === 2, 'native file import commits');
 const copy = useViewerStore.getState().savedScripts[1]; assert.notEqual(copy.id, original.id); assert.deepEqual({ ...copy, id: original.id }, original);
 assert.deepEqual(loadSavedScripts(), useViewerStore.getState().savedScripts); assert.equal(useViewerStore.getState().activeScriptId, original.id);
 assert.equal(useViewerStore.getState().scriptEditorContent, '// unsaved local edit'); assert.equal(useViewerStore.getState().scriptEditorDirty, true); assert.equal(useViewerStore.getState().scriptRunSeq, originalRunSequence());
});
function originalRunSequence() { return original.scriptRunSeq; }
for (const [name, content] of [['corrupt JSON', '{broken'], ['unknown format version', JSON.stringify({kind:'ifc-lite-script',version:2,script:{}})], ['unknown native script version', JSON.stringify({id:'future',name:'Future',code,createdAt:1,updatedAt:1,version:2})], ['oversized code', JSON.stringify({id:'large',name:'Large',code:'x'.repeat(100001),createdAt:1,updatedAt:1,version:1})]] as const) test(`#7258 ${name} is refused without altering native source`, async () => {
 const ui = mounted(); const before = localStorage.getItem('ifc-lite-scripts'); choose(ui, content);
 await waitFor(() => !!ui.querySelector('output'), 'native refusal is visible'); assert.equal(localStorage.getItem('ifc-lite-scripts'), before); assert.equal(useViewerStore.getState().savedScripts.length, 1);
});
test('#7258 recognized legacy native single record imports through the actual file control', async () => {
 const ui = mounted(); choose(ui, JSON.stringify(useViewerStore.getState().savedScripts[0])); await waitFor(() => useViewerStore.getState().savedScripts.length === 2, 'legacy record migrated'); assert.equal(loadSavedScripts().length, 2);
});
test('#7258 actual storage quota refuses import, preserves native state, and explicit Retry commits once', async () => {
 const ui = mounted(); const text = await exported(ui); const before = localStorage.getItem('ifc-lite-scripts');
 const write = mock.method(localStorage, 'setItem', () => { throw new DOMException('Actual storage quota refusal', 'QuotaExceededError'); });
 try { choose(ui, text); await waitFor(() => !![...ui.querySelectorAll('button')].find(button => button.textContent === 'Retry import into current library'), 'explicit recovery action'); assert.equal(useViewerStore.getState().savedScripts.length, 1); assert.equal(localStorage.getItem('ifc-lite-scripts'), before); } finally { write.mock.restore(); }
 const retry = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Retry import into current library'); assert.ok(retry); click(retry); assert.equal(loadSavedScripts().length, 2);
});
test('#7258 another tab changing storage while File.text awaits revokes import without overwriting the newer source', async () => {
 const ui = mounted(); const text = await exported(ui); let release: ((text:string)=>void) | undefined;
 choose(ui, text, () => new Promise(resolve => { release = resolve; }));
 const replacement = JSON.stringify({schemaVersion:1,scripts:[{...useViewerStore.getState().savedScripts[0], name:'Newer other-tab script'}]}); localStorage.setItem('ifc-lite-scripts',replacement);
 assert.ok(release); await act(async () => { release(text); }); await waitFor(() => !!ui.querySelector('output'), 'changed source refusal');
 assert.match(ui.textContent ?? '', /Saved scripts changed/); assert.equal(localStorage.getItem('ifc-lite-scripts'),replacement); assert.equal(useViewerStore.getState().savedScripts.length,1);
});
test('#7258 imported saved copy executes only after native selector open and explicit Run against actual SketchUp IFC', async () => {
 const bytes = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
 const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
 useViewerStore.setState(fixtureModels({...fixtureModel('ifc'), ifcDataStore:store}));
 assert.equal(sdk.query().byType('IfcWall').toArray().length,4);
 const ui = mounted(); const text = await exported(ui); const sequence = useViewerStore.getState().scriptRunSeq;
 choose(ui,text); await waitFor(() => useViewerStore.getState().savedScripts.length===2, 'native import'); assert.equal(useViewerStore.getState().scriptRunSeq,sequence);
 const copy = useViewerStore.getState().savedScripts[1]; act(() => useViewerStore.getState().setActiveScriptId(copy.id));
 const run = [...ui.querySelectorAll('button')].find(button => button.textContent?.trim()==='Run'); assert.ok(run, 'native explicit Run'); click(run);
 await waitFor(() => useViewerStore.getState().scriptExecutionState==='success' || useViewerStore.getState().scriptExecutionState==='error', 'native sandbox terminal execution');
 assert.equal(useViewerStore.getState().scriptExecutionState,'success',useViewerStore.getState().scriptLastError ?? 'native script execution failed');
 assert.equal(useViewerStore.getState().scriptRunSeq,sequence+1); assert.ok(useViewerStore.getState().scriptLastResult?.logs.some(row => row.args.includes(4)), 'native imported query logs actual four walls');
});

for (const [name, raw] of [['corrupt stored library','{broken'],['partly invalid stored library',JSON.stringify({schemaVersion:1,scripts:[null]})],['future stored schema',JSON.stringify({schemaVersion:2,scripts:[]})]] as const) test(`#7258 ${name} refuses file import and preserves original storage bytes`, async () => {
 const ui = mounted(); const text = await exported(ui); localStorage.setItem('ifc-lite-scripts',raw); choose(ui,text); await waitFor(() => !!ui.querySelector('output'), 'storage refusal visible');
 assert.equal(localStorage.getItem('ifc-lite-scripts'),raw); assert.equal(useViewerStore.getState().savedScripts.length,1);
});
test('#7258 unmount during native file read cannot append a hidden imported script later', async () => {
 const ui = mounted(); const text = await exported(ui); const raw=localStorage.getItem('ifc-lite-scripts'); let release:((text:string)=>void)|undefined;
 choose(ui,text,()=>new Promise(resolve=>{release=resolve;})); cleanup(); assert.ok(release); await act(async()=>{release(text);});
 assert.equal(localStorage.getItem('ifc-lite-scripts'),raw); assert.equal(useViewerStore.getState().savedScripts.length,1);
});
test('#7258 native rename during file read revokes import and preserves the actual newer saved record', async () => {
 const ui=mounted(); const text=await exported(ui); let release:((text:string)=>void)|undefined;
 choose(ui,text,()=>new Promise(resolve=>{release=resolve;})); act(()=>useViewerStore.getState().renameScript(useViewerStore.getState().savedScripts[0].id,'Newer native name'));
 const raw=localStorage.getItem('ifc-lite-scripts'); assert.ok(release); await act(async()=>{release(text);}); await waitFor(()=>!!ui.querySelector('output'),'native library freshness refusal');
 assert.equal(localStorage.getItem('ifc-lite-scripts'),raw); assert.equal(loadSavedScripts()[0].name,'Newer native name'); assert.equal(useViewerStore.getState().savedScripts.length,1);
});

test('#7258 other-tab replacement already present before file selection cannot be overwritten by stale session import', async () => {
 const ui=mounted(); const text=await exported(ui);
 const newer=JSON.stringify({schemaVersion:1,scripts:[{...useViewerStore.getState().savedScripts[0],name:'Already newer other-tab source'}]}); localStorage.setItem('ifc-lite-scripts',newer);
 choose(ui,text); await waitFor(()=>!!ui.querySelector('output'),'native import terminal message');
 assert.equal(localStorage.getItem('ifc-lite-scripts'),newer,'import must not overwrite another tab with the stale in-memory library'); assert.equal(useViewerStore.getState().savedScripts.length,1);
});
