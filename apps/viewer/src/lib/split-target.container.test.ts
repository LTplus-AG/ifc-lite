/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A wall contained directly in IfcBuilding, not in a storey (#6232 ledger
 * follow-up). Split still refuses it: both halves are written through the
 * storey-anchored builders and placed on a storey workplane, and a building
 * has neither a storey elevation nor a plan frame. But the refusal said "not
 * contained in a building storey", which reads as "not contained at all" for
 * a wall that plainly sits in the building. Both the Split button's reason
 * and the commit's own refusal now say where the wall is.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { effectiveContainerTypeName, effectiveStoreyId } from './effective-storey.js';
import { resolveSplitTarget, splitUnavailableKey } from './split-target.js';

let wallId = 0;

beforeEach(async () => {
  const view = await seedModelingSession();
  const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in wall);
  wallId = wall.expressId;
  const editor = useViewerStore.getState().storeEditors.get(MODEL_ID)!;
  const building = editor.addEntity('IfcBuilding', ['0Ax0Ax0Ax0Ax0Ax0Ax0Ax', null, 'B', null, null, '#41', null, null, '.ELEMENT.', null, null, null]).expressId;
  const rel = view.getNewEntities().find((e) => e.type === 'IfcRelContainedInSpatialStructure'
    && Array.isArray(e.attributes[4]) && e.attributes[4].includes(`#${wallId}`));
  assert.ok(rel);
  view.setAttribute(rel.expressId, 'RelatingStructure', `#${building}`);
});

describe('a wall on IfcBuilding, not a storey (#6232)', () => {
  it('has no storey, and its container reads IfcBuilding', () => {
    const s = useViewerStore.getState();
    const store = s.models.get(MODEL_ID)!.ifcDataStore!;
    const view = s.mutationViews.get(MODEL_ID)!;
    assert.equal(effectiveStoreyId(store, view, wallId), undefined);
    assert.match(effectiveContainerTypeName(store, view, wallId) ?? '', /^ifcbuilding$/i);
  });

  it('the Split button names the building, not a missing storey', () => {
    const s = useViewerStore.getState();
    const target = resolveSplitTarget(
      s.models.get(MODEL_ID)!.ifcDataStore!, s.mutationViews.get(MODEL_ID)!, s.storeEditors.get(MODEL_ID)!, wallId, 1,
    );
    assert.ok(!target.ok);
    assert.equal(target.code, 'container');
    assert.equal(splitUnavailableKey(target.code), 'splitTool.unavailable.container');
  });

  it('the split commit refuses with where the wall sits', () => {
    const result = useViewerStore.getState().splitWallAtDistance(MODEL_ID, wallId, 2);
    assert.ok(!result.ok);
    assert.match(result.reason, /not contained in a building storey: it sits in IfcBuilding, not on a storey/i);
  });
});
