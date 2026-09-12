/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, useState } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { pdfReferenceAnnotationFixture } from '@/test/pdf-reference-annotation-fixture';
import { render, cleanup, click } from '@/test/render';
import type { AppearanceWorkerRequest, AppearanceWorkerResponse } from '@/lib/appearance/planner-types';
import type { PdfFillAnnotationPlan } from '@/lib/appearance/pdf/fill-plan-types';
import type { PreparedPdfVectorPage } from '@/lib/appearance/pdf/vector-types';
import { PdfAnnotationFields } from './PdfAnnotationFields';

type NativeApi = { preparePdfVectorPage(json: string): Uint8Array; planPdfFillAnnotation(source: Uint8Array, json: string): Uint8Array; free(): void };
const HELVETICA = '/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>';
async function until(predicate: () => boolean) {
  for (let tries = 0; tries < 100 && !predicate(); tries++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.ok(predicate(), 'bounded mounted interaction completed');
}
async function nativeApi(t: TestContext): Promise<NativeApi | undefined> {
  let binary: Buffer;
  try { binary = await readFile(new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; t.skip('Build WASM with pnpm build:wasm'); return; }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm'); await init({ module_or_path: binary });
  return new IfcAPI();
}
type WorkerMode = { pending?: () => void; deferFill: boolean; terminations: number };
/** The production planner client with real native work; fidelity replies at once, fill plans can be held back. */
function installWorker(api: NativeApi, mode: WorkerMode) {
  class ControlledWorker {
    onmessage: ((event: MessageEvent<AppearanceWorkerResponse>) => void) | null = null;
    onerror = null; onmessageerror = null;
    terminate() { mode.terminations++; }
    postMessage(message: AppearanceWorkerRequest) {
      const handler = this.onmessage, reply = (data: AppearanceWorkerResponse) => handler?.(new MessageEvent('message', { data }));
      if (message.type === 'pdf-fidelity') {
        const result = JSON.parse(new TextDecoder().decode(api.preparePdfVectorPage(JSON.stringify(message.request)))) as PreparedPdfVectorPage;
        queueMicrotask(() => reply({ type: 'pdf-fidelity-complete', id: message.id, result })); return;
      }
      if (message.type !== 'pdf-fill-plan') throw new Error('Unexpected planner job');
      const deliver = () => reply({ type: 'pdf-fill-complete', id: message.id,
        result: JSON.parse(new TextDecoder().decode(api.planPdfFillAnnotation(message.source, JSON.stringify(message.request)))) as PdfFillAnnotationPlan });
      if (mode.deferFill) mode.pending = deliver; else queueMicrotask(deliver);
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: ControlledWorker });
  return () => { if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else Reflect.deleteProperty(globalThis, 'Worker'); };
}
function mockPreviewRenderer() {
  mock.method(Renderer.prototype, 'init', async () => {});
  mock.method(Renderer.prototype, 'loadGeometry', () => {});
  mock.method(Renderer.prototype, 'fitToView', () => {});
  mock.method(Renderer.prototype, 'render', () => {});
}
const buttons = (ui: HTMLElement) => (name: string) => [...ui.querySelectorAll('button')].find(item => item.textContent === name);

test('PDF preview cancellation, changed inputs and stale models cannot enable late native results (#4406)', async t => {
  const api = await nativeApi(t); if (!api) return;
  const fixture = await pdfReferenceAnnotationFixture(), mode: WorkerMode = { deferFill: true, terminations: 0 }, restore = installWorker(api, mode);
  mockPreviewRenderer();
  function Panel() {
    const [Name, setName] = useState('First annotation');
    return <><button onClick={() => setName('Changed annotation')}>Change annotation name</button>
      <PdfAnnotationFields referenceId={fixture.reference.id} modelId="pdf-target" containerId={40} Name={Name} disabled={false} /></>;
  }
  try {
    const ui = render(<Panel />), button = buttons(ui);
    const start = async () => { mode.pending = undefined; click(button('Prepare vector preview')!); await until(() => !!mode.pending); };
    await start(); const lateCancel = mode.pending!;
    click(button('Cancel')!); await act(async () => { lateCancel(); });
    assert.ok(mode.terminations > 0); assert.equal(button('Create annotation'), undefined);
    assert.match(ui.textContent ?? '', /cancelled/);
    await start(); const lateInput = mode.pending!;
    assert.match(ui.textContent ?? '', /Exact conversion: 2 convertible paths/, 'the report stays visible while the plan is prepared');
    click(button('Change annotation name')!); await act(async () => { lateInput(); });
    assert.equal(button('Create annotation'), undefined, 'changed visible Name cannot reuse the previous planned IFC metadata');
    await start(); await act(async () => { mode.pending!(); });
    await until(() => !!button('Create annotation') && !button('Create annotation')!.disabled);
    assert.equal(fixture.view.getNewEntities().length, 0, 'ready preview still has no authored IFC rows');
    act(() => useViewerStore.setState({ models: new Map() }));
    await until(() => button('Create annotation') === undefined);
    assert.match(ui.textContent ?? '', /target model changed/);
    assert.equal(fixture.view.getNewEntities().length, 0);
  } finally { cleanup(); mock.restoreAll(); restore(); fixture.dispose(); api.free(); }
});

test('partial pages show the report, need explicit acceptance and record their omissions; raster-only pages never convert (#4406)', async t => {
  const api = await nativeApi(t); if (!api) return;
  const partial = await pdfReferenceAnnotationFixture({ resources: HELVETICA,
    contents: 'BT /F1 12 Tf 10 20 Td (Visible text) Tj ET\n1 0 0 rg 20 30 30 30 re f\n0 1 0 rg 90 60 20 30 re f\n' });
  const restore = installWorker(api, { deferFill: false, terminations: 0 });
  mockPreviewRenderer();
  const owners = new Map<number, readonly MeshData[]>();
  const renderer = { prepareAuthoredOwner(parts: readonly MeshData[]) { return { commit() { owners.set(parts[0]!.expressId, parts); }, dispose() {} }; },
    getScene: () => ({ getMeshDataPieces: (id: number) => owners.get(id), removeMeshesForEntities(ids: Iterable<number>) { for (const id of ids) owners.delete(id); } }),
    requestRender() {}, invalidateBVHCache() {} } as unknown as Renderer;
  setGlobalRendererRef({ current: renderer });
  try {
    const ui = render(<PdfAnnotationFields referenceId={partial.reference.id} modelId="pdf-target" containerId={40} Name="Partial page" disabled={false} />);
    const button = buttons(ui), checkbox = () => ui.querySelector<HTMLInputElement>('input[type="checkbox"]');
    click(button('Prepare vector preview')!);
    await until(() => !!checkbox());
    assert.match(ui.textContent ?? '', /Partial conversion: 1 visible omission would be left out; 2 paths convert/);
    assert.match(ui.textContent ?? '', /1 × Text runs — region x 10–/);
    assert.match(ui.textContent ?? '', /accept the partial conversion to prepare it/);
    assert.equal(button('Create annotation'), undefined);
    assert.ok(button('Prepare partial conversion')!.disabled, 'no partial preparation without acceptance');
    click(checkbox()!);
    assert.ok(!button('Prepare partial conversion')!.disabled);
    click(button('Prepare partial conversion')!);
    await until(() => !!button('Create annotation') && !button('Create annotation')!.disabled);
    assert.match(ui.textContent ?? '', /Review 2 coloured regions of the accepted partial conversion/);
    assert.equal(partial.view.getNewEntities().length, 0, 'the preview publishes nothing');
    click(button('Create annotation')!);
    await until(() => button('Create annotation') === undefined && partial.view.getNewEntities().length > 0);
    const rows = partial.view.getNewEntities();
    const annotation = rows.find(row => row.type === 'IfcAnnotation'), set = rows.find(row => row.type === 'IfcPropertySet');
    assert.ok(annotation && set, 'one annotation with its provenance property set');
    assert.equal(set.attributes[2], 'IfcLite_PdfVectorConversion');
    assert.match(String(annotation.attributes[3]), /partial conversion; omitted 1 text/);
    assert.ok(rows.some(row => row.type === 'IfcPropertySingleValue' && row.attributes[0] === 'AcceptedPartialConversion'));
    assert.ok(rows.some(row => row.type === 'IfcRelDefinesByProperties'));
    assert.equal(owners.get(annotation.expressId)?.length, 2, 'both coloured parts are published under the one owner');
    assert.equal(useViewerStore.getState().undoStacks.get('pdf-target')?.length, 1, 'one ordinary Undo entry');
    assert.match(ui.textContent ?? '', /accepted omissions are recorded in its IfcLite_PdfVectorConversion property set/);
  } finally { cleanup(); mock.restoreAll(); restore(); setGlobalRendererRef({ current: null }); partial.dispose(); }
  const raster = await pdfReferenceAnnotationFixture({ contents: 'q 100 0 0 72 10 20 cm BI /W 1 /H 1 /CS /G /BPC 8 /F /AHx ID 80> EI Q\n' });
  const restoreRaster = installWorker(api, { deferFill: false, terminations: 0 });
  try {
    const ui = render(<PdfAnnotationFields referenceId={raster.reference.id} modelId="pdf-target" containerId={40} Name="Scan" disabled={false} />);
    const button = buttons(ui);
    click(button('Prepare vector preview')!);
    await until(() => /raster reference only/.test(ui.textContent ?? ''));
    assert.ok(button('Prepare vector preview')!.disabled, 'a raster-only page is never offered as editable vectors');
    assert.equal(ui.querySelector('input[type="checkbox"]'), null);
    assert.equal(button('Create annotation'), undefined);
    assert.equal(raster.view.getNewEntities().length, 0);
  } finally { cleanup(); restoreRaster(); raster.dispose(); api.free(); }
});
