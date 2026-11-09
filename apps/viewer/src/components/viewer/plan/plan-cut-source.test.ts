/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { toGlobalIdFromModels } from '@/store/globalId';
import '@/lib/commands/modeling/builtin';
import { resolvePlanSnap } from './PlanPointer';
import { createPlanCutSource, planCutLinework } from './plan-cut-source';

afterEach(() => useViewerStore.getState().exitModelWorkspace());
for (const x of [2, 4]) it(`#9296 plan body snap at ${x} lands on the reference even zoomed past its snap radius`, async () => {
  await seedModelingSession();
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0,0,0], End: [4,0,0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in wall);
  s.startCommand('wall.place');
  // Stated geometry: a centred 200mm wall has its faces at y = ±100mm.
  const entityId = toGlobalIdFromModels(s.models, MODEL_ID, wall.expressId);
  const linework = planCutLinework([{ entityId, ifcType: 'IfcWall', outer: [[0,-0.1],[4,-0.1],[4,0.1],[0,0.1]], holes: [] }], []);
  const snap = resolvePlanSnap({ local: [x,0.1], metresPerPixel: 0.001, snapping: true, mods: { shiftKey: false, altKey: false }, planSources: [createPlanCutSource(() => linework)] });
  assert.deepEqual(snap?.local, [x,0]);
  assert.equal(snap?.winner?.kind, x === 2 ? 'midpoint' : 'endpoint');
});
