/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { initSync } from '@ifc-lite/wasm';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef, clearGlobalRefs } from '@/hooks/useBCF';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, cleanup, click, advance } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import type { RetainedGeometrySummary } from '@/store/retainedGeometry';
import { ExportDialog } from './ExportDialog';
import '@/lib/retained/retainedLoad';

const initial = useViewerStore.getState();
const complete: RetainedGeometrySummary = { kernel: 'retained', candidates: 1, published: 1,
  refused: [], cancelled: 0, obligationsUnmet: [], completeness: 'complete' };
afterEach(() => { cleanup(); clearDownloads(); clearGlobalRefs(); mock.restoreAll(); useViewerStore.setState(initial); });
function button(label: string) {
  const el = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
  assert.ok(el, label); return el;
}
function toggle(label: string) {
  const el = [...document.querySelectorAll('label')].find(node => node.textContent?.trim() === label);
  const control = el?.parentElement?.parentElement?.querySelector('[role="switch"]');
  assert.ok(control, label); click(control);
}
async function setup(retained: RetainedGeometrySummary | undefined) {
  initSync({ module: new Uint8Array(readFileSync(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url))) });
  const bytes = new Uint8Array(readFileSync(new URL('../../../../../tests/fixtures/synthetic-retained/f-c-extrusion.ifc', import.meta.url)));
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const model = { ...fixtureModel('m'), ifcDataStore: store, schemaVersion: 'IFC4' as const,
    ...(retained ? { retainedGeometry: retained } : {}) };
  useViewerStore.setState({ ...fixtureModels(model), sectionPlane: { ...initial.sectionPlane,
    enabled: true, custom: { normal: [1, 0, 0], distance: 0, pickedAt: [0, 0, 0], tangent: [0, 1, 0], bitangent: [0, 0, 1] } } });
  setGlobalRendererRef({ current: { getCamera: () => ({ getSceneBounds: () =>
    ({ min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } }) }) } as unknown as Renderer });
  render(<ExportDialog surface="ribbon" />);
  click(button('Export IFC'));
  toggle('Export Visible Only');
  assert.ok(document.getElementById('trim-section-export'), 'an actual section export is requested');
  return model;
}

// #8415: both exact trimming and exact outside classification are forbidden for retained loads.
for (const afterOpen of [false, true]) for (const incomplete of [false, true]) {
  it(`refuses sectioned IFC4 for ${incomplete ? 'incomplete' : 'complete'} retained, kernel changes after open: ${afterOpen}`, async () => {
    const summary: RetainedGeometrySummary = incomplete ? { ...complete, candidates: 2,
      completeness: 'incomplete', refused: [{ expressId: 999, ifcType: 'IfcWall', code: 'refused' }] } : complete;
    const model = await setup(afterOpen ? undefined : summary);
    if (incomplete) click(document.getElementById('trim-section-export')!); // whole elements still classify exact geometry
    if (afterOpen) act(() => useViewerStore.setState({ models: new Map([['m', { ...model, retainedGeometry: summary }]]) }));
    const planner = mock.method(GeometryProcessor.prototype, 'planSectionExport', () => { throw new Error('exact planner must not run'); });
    click(button('Export')); await advance(100);
    assert.equal(planner.mock.callCount(), 0);
    assert.deepEqual(downloadedNames(), []);
    assert.match(document.body.textContent ?? '', /Reload that model with the exact kernel/);
  });
}

it('control: retained unsectioned IFC4 still downloads with the section disabled', async () => {
  await setup(complete);
  act(() => useViewerStore.setState({ sectionPlane: { ...useViewerStore.getState().sectionPlane, enabled: false } }));
  click(button('Export'));
  for (let i = 0; i < 100 && !downloadedNames().length; i++) await advance(20);
  assert.equal(downloadedNames().length, 1, document.body.textContent ?? 'no download');
});
