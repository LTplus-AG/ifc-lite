/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955: the IFC5 output carries the meshes the viewer holds, so an incomplete or shape-only retained model refuses
 * it with the shape-only reason (the guard the GLB/KMZ/USD ribbon commands use). The same dialog on the same model
 * without a retained summary exports.
 */
import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { Ifc5Exporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { render, cleanup, click, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import type { RetainedGeometrySummary } from '@/store/retainedGeometry';
import { ExportDialog } from './ExportDialog.js';
// The retained module registers the shape-only reason's English text.
import '@/lib/retained/retainedLoad';

const initialState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState(initialState);
});

const INCOMPLETE: RetainedGeometrySummary = {
  kernel: 'retained', candidates: 2, started: true, published: 1,
  refused: [{ expressId: 2, ifcType: 'IfcBuildingElementProxy', code: 'appearance_unsupported' }],
  cancelled: 0, obligationsUnmet: [], completeness: 'incomplete',
};

async function exportIfc5(retainedGeometry: RetainedGeometrySummary | undefined, mode?: 'properties' | 'changes') {
  const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;
  const bytes = new TextEncoder().encode(source);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const model = { ...fixtureModel('model'), ifcDataStore: store, schemaVersion: 'IFC5' as const, ...(retainedGeometry ? { retainedGeometry } : {}) };
  useViewerStore.setState({ ...fixtureModels(model), activeModelId: model.id, dirtyModels: new Set(), mutationVersion: 0 });
  const exported = mock.method(Ifc5Exporter.prototype, 'export', () => ({ content: '{}', stats: { skippedCount: 0, propertyCollisions: 0, nodeCount: 0, meshCount: 0, propertyCount: 0 } }) as never);
  const ui = render(<ExportDialog surface="ribbon" initialChangesOnly={mode === 'changes'} />);
  const trigger = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Export IFC'));
  assert.ok(trigger);
  click(trigger);
  if (mode === 'properties') {
    const label = [...document.querySelectorAll('label')].find(el => el.textContent?.trim() === 'Include geometry');
    assert.ok(label);
    const toggle = label.parentElement?.querySelector('button[role="switch"]');
    assert.ok(toggle);
    click(toggle);
    await advance(10);
  }
  const run = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Export');
  assert.ok(run);
  click(run);
  await advance(50);
  return exported.mock.callCount();
}

it('refuses the IFC5 export of an incomplete retained model with the shape-only reason', async () => {
  assert.equal(await exportIfc5(INCOMPLETE), 0, 'no IFC5 is built from partial retained meshes');
  assert.match(document.body.textContent ?? '', /Unavailable while retained geometry or presentation is incomplete/);
});

it('control: the same IFC5 export without a retained summary runs', async () => {
  assert.equal(await exportIfc5(undefined), 1);
});

// #8415: property-only IFCX must survive a geometry refusal.
it('exports IFC5 properties without geometry from an incomplete retained model', async () => {
  assert.equal(await exportIfc5(INCOMPLETE, 'properties'), 1);
});
it('exports IFC5 changes only from an incomplete retained model', async () => {
  assert.equal(await exportIfc5(INCOMPLETE, 'changes'), 1);
});
