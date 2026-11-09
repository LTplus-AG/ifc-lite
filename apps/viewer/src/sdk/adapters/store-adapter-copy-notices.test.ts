/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9352 through the viewer's `bim.store`, as headless: a copy returns every
 * selected element, a copy whose top cannot follow says so (result and one
 * toast), and `TopConstraint` applies to curtain walls and grid columns.
 */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { readStoreyInventory, readTopAttachment, rectangularGridAxes, writeTopAttachment } from '@ifc-lite/create';
import { toast } from '@/components/ui/toast';
import { resolve as translate } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import { MESH_WALL, MODEL_ID, STOREY, UPPER_STOREY, fixtureStep, seedModelingSession } from '@/test/modeling-session-fixture';
import { createStoreAdapter } from './store-adapter';
import { loadStoreyAdapter } from './store-adapter-storey';

const realInfo = toast.info;
let notes: string[] = [];
beforeEach(async () => { await loadStoreyAdapter(); notes = []; (toast as { info: (m: string) => void }).info = (m) => notes.push(m); });
afterEach(() => { Object.assign(toast, { info: realInfo }); });

// Attachment defaults use the actual placement floor, not just Elevation.
// The generic gesture fixture shares both storeys' placement; give L1 its 3 m frame.
const seedAttachmentSession = () => seedModelingSession({ step: fixtureStep({}).replace(
  '#51=IFCLOCALPLACEMENT($,#42);',
  '#51=IFCLOCALPLACEMENT($,#52);\n#52=IFCAXIS2PLACEMENT3D(#53,$,$);\n#53=IFCCARTESIANPOINT((0.,0.,3.));',
) });

const model = () => {
  const state = useViewerStore.getState();
  return { dataStore: state.models.get(MODEL_ID)!.ifcDataStore!, view: state.mutationViews.get(MODEL_ID)! };
};
const attachment = (id: number) => { const { dataStore, view } = model(); return readTopAttachment(readStoreyInventory(dataStore, view), id); };

it('copyElements returns a window selected with its wall as its own copy', async () => {
  await seedAttachmentSession();
  const adapter = createStoreAdapter(useViewerStore);
  const wall = adapter.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 2.5 });
  const window = adapter.addHostedWindow(MODEL_ID, wall.expressId, { Offset: 1, Sill: 0.9, Width: 1.2, Height: 1.2 });
  const refs = adapter.copyElements!(MODEL_ID, [wall.expressId, window.expressId], [{ offset: [0, 3, 0] }, { offset: [0, 6, 0] }]);
  assert.equal(refs.length, 4, 'one copy per selected element per transform');
  assert.equal(new Set(refs.map((ref) => ref.expressId)).size, 4);
  assert.deepEqual(notes, []);
});

it('a copy whose top cannot follow its new storey is listed on its ref and told once', async () => {
  await seedAttachmentSession();
  const adapter = createStoreAdapter(useViewerStore);
  adapter.addStorey!(MODEL_ID, { Name: 'L2', Elevation: 7 });
  const { dataStore, view } = model();
  const upper = readStoreyInventory(dataStore, view).storeys.find((s) => s.expressId === UPPER_STOREY)!;
  writeTopAttachment(view, MESH_WALL, upper.GlobalId, 'relative');
  // L1 to L2 is 4 m, L0 to L1 was 3 m: the mesh wall's body cannot take the new height.
  const [copy] = adapter.copyElements!(MODEL_ID, [MESH_WALL], [{ targetStoreyId: UPPER_STOREY }]);
  assert.equal(copy.unattachedTops?.length, 1);
  assert.equal(copy.unattachedTops![0].expressId, copy.expressId);
  assert.equal(attachment(copy.expressId), null, 'left fixed, not attached at the wrong height');
  assert.deepEqual(notes, [translate('copyArray.unattachedTops', { count: 1, countDisplay: '1' })]);
});

it('addCurtainWall and addColumnOnGrid apply TopConstraint, auto by default', async () => {
  await seedAttachmentSession();
  const adapter = createStoreAdapter(useViewerStore);
  const reaches = adapter.addCurtainWall!(MODEL_ID, STOREY, { Start: [0, 8, 0], End: [4, 8, 0], Height: 3, UGrid: 2, VGrid: 2 });
  assert.equal(attachment(reaches.expressId)?.targetStoreyId, UPPER_STOREY, 'auto: drawn up to the storey above');
  const fixed = adapter.addCurtainWall!(MODEL_ID, STOREY, { Start: [0, 10, 0], End: [4, 10, 0], Height: 3, UGrid: 2, VGrid: 2, TopConstraint: { kind: 'fixed' } });
  assert.equal(attachment(fixed.expressId), null);
  const grid = adapter.addGrid!(MODEL_ID, STOREY, rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }));
  // IfcGrid.UAxes and VAxes (attributes 7 and 8).
  const record = model().view.getNewEntity(grid.expressId)!;
  const first = (value: unknown) => Number(String((value as unknown[])[0]).replace('#', ''));
  const u = first(record.attributes[7]), v = first(record.attributes[8]);
  assert.ok(Number.isSafeInteger(u) && Number.isSafeInteger(v), 'the grid has U and V axes');
  const column = adapter.addColumnOnGrid!(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 0.4, Depth: 0.4, Height: 2.5, TopConstraint: { kind: 'storeyAbove' } },
    { GridId: grid.expressId, IntersectingAxes: [u, v] });
  assert.equal(attachment(column.expressId)?.targetStoreyId, UPPER_STOREY, 'an explicit constraint is applied');
});
