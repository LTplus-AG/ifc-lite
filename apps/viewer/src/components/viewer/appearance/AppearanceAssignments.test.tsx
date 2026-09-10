/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { act, StrictMode, useState } from 'react';
import { federationRegistry } from '@ifc-lite/renderer';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { getGlobalRenderer, setGlobalRendererRef } from '@/hooks/useBCF';
import { appearanceAssets, modelAppearanceAssets } from '@/lib/appearance/model-assets.js';
import { coordinatedFixture } from '@/lib/appearance/coordinated-command.fixture.js';
import { DEFAULT_APPEARANCE_SETTINGS } from '@/lib/appearance/settings.js';
import { AppearanceAssignments } from './AppearanceAssignments.js';
import { useAppearanceAssignments } from './useAppearanceAssignments.js';
import type { AppearancePanelViewProps } from './types.js';
import { installAssignmentWorker } from './assignment-worker.fixture.js';
const wasm = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);

function Harness({ initialEnabled = true }: { initialEnabled?: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [modelId, setModelId] = useState('a');
  const sources = useViewerStore(state => state.appearanceSources);
  const models = useViewerStore(state => state.models);
  const base: AppearancePanelViewProps = { models: [...models].map(([id]) => ({id,name:id})), modelId,
    onModelChange: setModelId, sources, sourceId: sources[0]?.id ?? null, onSourceChange() {}, onUpload() {},
    scope: {kind:'model'}, onScopeChange() {}, classes: [], types: [], selectionCount: 0, affectedCount: 1, excludedCount: 0,
    settings: {...DEFAULT_APPEARANCE_SETTINGS, kind:'planar', plane:'xy', tileWidth: modelId === 'a' ? 2 : 4}, onSettingsChange() {},
    status:'idle', canApply:false, canDiscard:false, hasPreview:false, showingOriginal:false, onCompareChange() {}, onApply() {}, onDiscard() {},
  };
  const c = useAppearanceAssignments(base, enabled);
  return <><button onClick={() => setEnabled(true)}>Use image appearance</button><button onClick={() => { setModelId('b'); useViewerStore.getState().setActiveModel('b'); }}>Choose model b</button>
    <AppearanceAssignments controller={c} base={base} />
    <p role="status" data-operation-status={c.status}>{c.notice}</p>
    <button disabled={c.status !== 'ready' || c.original} onClick={() => { void c.apply(); }}>Apply assignments</button>
    <button onClick={c.cancel}>Cancel assignments</button>
  </>;
}
function button(ui: HTMLElement, name: string) {
  const found = [...ui.querySelectorAll('button')].find(button => button.textContent === name);
  assert.ok(found, `Missing button ${name}`); return found;
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await advance(10);
  assert.ok(predicate(), `Mounted operation did not reach its expected state: ${document.body.textContent}`);
}
for (const scenario of ['apply', 'cancel', 'stale', 'room'] as const) test(`mounted native multi-model assignments ${scenario} preserve complete transaction scope #4420`, {
  skip: !existsSync(wasm) && 'Run pnpm build:wasm for native assignment tests',
}, async t => {
  const initial = useViewerStore.getState(), previousRenderer = getGlobalRenderer();
  const {default:init} = await import('@ifc-lite/wasm'); await init({module_or_path:await readFile(wasm)});
  const worker = installAssignmentWorker();
  const f = await coordinatedFixture();
  setGlobalRendererRef({current:f.renderer});
  t.mock.method(appearanceAssets, 'decode', async () => ({width:1,height:1,close(){}} as ImageBitmap));
  useViewerStore.setState({ appearanceAssignments:null, appearanceSources:[{id:f.asset.id,name:'Texture',width:1,height:1}] });
  try {
    let ui = render(<StrictMode><Harness /></StrictMode>);
    click(button(ui, 'Add this scope'));
    await until(() => useViewerStore.getState().appearanceAssignments?.assignments.length === 1);
    click(button(ui, 'Choose model b')); click(button(ui, 'Add this scope'));
    await until(() => useViewerStore.getState().appearanceAssignments?.assignments.length === 2);
    assert.equal(useViewerStore.getState().undoStacks.size, 0);
    if (scenario === 'apply') {
      cleanup(); ui = render(<StrictMode><Harness initialEnabled={false} /></StrictMode>);
      click(button(ui, 'Use image appearance'));
      await until(() => !button(ui, 'Preview all assignments').disabled);
      assert.ok(!ui.textContent?.includes('Review current scope'), 'unchanged in-session scopes resume without confirmation');
    }
    if (scenario === 'cancel' || scenario === 'stale') worker.hold();
    click(button(ui, 'Preview all assignments'));
    if (scenario === 'cancel' || scenario === 'stale') {
      await until(() => worker.waiting() === 1);
      if (scenario === 'cancel') click(button(ui, 'Cancel assignments'));
      else act(() => useViewerStore.getState().setPositionalAttribute('b',25,2,'Changed while planning'));
      worker.release(); await until(() => ui.querySelector('[data-operation-status]')?.getAttribute('data-operation-status') !== 'preparing');
      assert.equal(button(ui,'Apply assignments').disabled,true);
      for (const entry of f.entries) assert.equal(f.scene.get(entry.globalId)?.parts[0].texture,undefined);
      assert.equal(useViewerStore.getState().undoStacks.get('a')?.length ?? 0,0);
      assert.equal(useViewerStore.getState().undoStacks.get('b')?.length ?? 0,scenario === 'stale' ? 1 : 0);
      return;
    }
    await until(() => !button(ui,'Apply assignments').disabled);
    if (scenario === 'room') {
      act(() => useViewerStore.setState({collabRoomId:'room-block'}));
      assert.equal(button(ui,'Apply assignments').disabled,true);
      assert.equal(button(ui,'Preview all assignments').disabled,true);
      for (const entry of f.entries) {
        assert.equal(f.scene.get(entry.globalId)?.parts[0].texture,undefined);
        assert.equal(useViewerStore.getState().undoStacks.get(entry.modelId)?.length ?? 0,0);
      }
      return;
    }
    const atlasUvs = f.entries.map(entry => Array.from(f.scene.get(entry.globalId)!.parts[0].uvs!));
    assert.notDeepEqual(atlasUvs[0],atlasUvs[1],'different saved tile widths reach their model previews');
    click(button(ui,'Apply assignments'));
    await until(() => ui.textContent?.includes('All assignments applied.') === true);
    for (const entry of f.entries) assert.equal(useViewerStore.getState().undoStacks.get(entry.modelId)?.length,1);
    act(() => useViewerStore.getState().undo('b'));
    for (const entry of f.entries) assert.equal(f.scene.get(entry.globalId)?.parts[0].texture,undefined);
    act(() => useViewerStore.getState().redo('a'));
    for (const [index,entry] of f.entries.entries()) assert.deepEqual(Array.from(f.scene.get(entry.globalId)!.parts[0].uvs!),atlasUvs[index]);
    assert.equal(button(ui,'Apply assignments').disabled,true,'completed or invalidated draft cannot be applied twice');
    assert.equal(useViewerStore.getState().appearanceAssignments?.assignments.length,2,'logical recipe remains after Apply');
    act(() => useViewerStore.getState().setPositionalAttribute('a',25,0,'0Proxy000000000000000z'));
    cleanup();
    const restored = render(<StrictMode><Harness /></StrictMode>);
    assert.equal(button(restored,'Preview all assignments').disabled,true,'reopening never restores a live plan');
    click(button(restored,'Review current scope'));
    await until(() => restored.textContent?.includes('1 added · 1 removed') === true);
    assert.equal(button(restored,'Preview all assignments').disabled,true,'membership differences require explicit acceptance');
    click(button(restored,'Accept reviewed scope'));
    click(button(restored,'Review current scope'));
    await until(() => [...restored.querySelectorAll('button')].some(button => button.textContent === 'Accept reviewed scope'));
    click(button(restored,'Accept reviewed scope'));
    assert.equal(button(restored,'Preview all assignments').disabled,false);
    click(button(restored,'Preview all assignments'));
    await until(() => !button(restored,'Apply assignments').disabled);
    click(button(restored,'Cancel assignments'));
    assert.equal(button(restored,'Apply assignments').disabled,true);
  } finally {
    cleanup(); worker.dispose(); setGlobalRendererRef({current:previousRenderer});
    useViewerStore.getState().clearAllMutations(); modelAppearanceAssets.clear(); appearanceAssets.clear(); federationRegistry.clear();
    useViewerStore.setState(initial,true);
  }
});


test('two restored PDF sources in one model slot can be rebound together after document IDs change #4420', {
  skip: !existsSync(wasm) && 'Run pnpm build:wasm for native assignment tests',
}, async () => {
  const initial = useViewerStore.getState();
  const {default:init} = await import('@ifc-lite/wasm'); await init({module_or_path:await readFile(wasm)});
  const worker = installAssignmentWorker();
  const { createAppearancePlanner } = await import('@/lib/appearance/planner-worker-client.js');
  const { captureAppearanceAssignment } = await import('@/lib/appearance/assignments/capture.js');
  const { reviewRestoredAssignment } = await import('@/lib/appearance/assignments/restore.js');
  const { registerPdfDocument, removePdfDocument } = await import('@/lib/appearance/pdf/documents.js');
  const { PdfAppearanceSource } = await import('@/lib/appearance/pdf/source-document.js');
  const { controlledPdf } = await import('@/lib/appearance/pdf/fixtures.js');
  const f = await coordinatedFixture(), planner = createAppearancePlanner(), keys: string[] = [];
  const page = { pageNumber:1,viewBox:[0,0,72,72] as [number,number,number,number],userUnit:1,
    intrinsicRotation:0,widthPoints:72,heightPoints:72,pdfToPage:[1,0,0,-1,0,72] as [number,number,number,number,number,number] };
  const recipe = { page,rotation:0 as const,cropPoints:[0,0,72,72] as [number,number,number,number],
    requestedDpi:1,effectiveDpi:1,pixelWidth:1,pixelHeight:1,paperSizeMetres:[0.0254,0.0254] as [number,number],
    pixelToPdf:[72,0,0,-72,0,72] as [number,number,number,number,number,number] };
  async function source(index: number) {
    const document = await PdfAppearanceSource.open(new File([controlledPdf(),`\n% source ${index}\n`],`Page ${index}.pdf`),appearanceAssets,{
      worker:{async run(){return {kind:'inspect',pageCount:1,page};},cancel(){},dispose(){}},
    });
    const key = registerPdfDocument(document); keys.push(key);
    return {id:`${key}:page`,assetId:f.asset.id,name:`Page ${index}`,width:1,height:1,pdf:{documentKey:key,recipe}};
  }
  try {
    const originals = [await source(1),await source(2)];
    useViewerStore.setState({appearanceAssignments:null,appearanceSources:originals});
    const saved = [];
    for (const source of originals) saved.push((await captureAppearanceAssignment({modelId:'a',slotId:'shared-slot',
      sourceId:source.id,scope:{kind:'model'},settings:DEFAULT_APPEARANCE_SETTINGS,planner,signal:new AbortController().signal})).assignment);
    assert.notEqual(saved[0].source.pdf?.documentSha256,saved[1].source.pdf?.documentSha256,'original PDF bytes define identity');
    originals.forEach(source => removePdfDocument(source.pdf.documentKey));
    const replacements = [await source(1),await source(2)];
    useViewerStore.setState({appearanceSources:replacements,appearanceAssignments:{version:1,assignments:saved}});
    await assert.rejects(reviewRestoredAssignment({saved:saved[0],modelId:'a',sourceId:replacements[1].id,planner,
      signal:new AbortController().signal}),/original image derivative and PDF page/,'same raster from a different original PDF is refused');
    const ui = render(<StrictMode><Harness /></StrictMode>);
    const reviews = () => [...ui.querySelectorAll('button')].filter(button => button.textContent === 'Review current scope');
    assert.ok(reviews().every(button => button.disabled),'both missing source bindings block atomic review');
    const selects = [...ui.querySelectorAll('select')].filter(select => select.parentElement?.textContent?.startsWith('Original source'));
    assert.equal(selects.length,2);
    act(() => { selects[0].value=replacements[0].id; selects[0].dispatchEvent(new Event('change',{bubbles:true})); });
    assert.ok(reviews().every(button => button.disabled),'first staged source persists while the second is chosen');
    act(() => { selects[1].value=replacements[1].id; selects[1].dispatchEvent(new Event('change',{bubbles:true})); });
    assert.ok(reviews().every(button => !button.disabled));
    click(reviews()[0]);
    await until(() => ui.textContent?.includes('Accept reviewed scope') === true);
    assert.equal(ui.querySelector('[aria-label="Membership review"]')?.textContent?.match(/0 added/g)?.length,2);
    click(button(ui,'Accept reviewed scope'));
    assert.equal(button(ui,'Preview all assignments').disabled,false);
    assert.deepEqual(useViewerStore.getState().appearanceAssignments?.assignments.map(row => row.source.id),replacements.map(source => source.id));
  } finally {
    cleanup(); planner.dispose(); worker.dispose(); keys.forEach(removePdfDocument);
    useViewerStore.getState().clearAllMutations(); modelAppearanceAssets.clear(); appearanceAssets.clear(); federationRegistry.clear();
    useViewerStore.setState(initial,true);
  }
});
