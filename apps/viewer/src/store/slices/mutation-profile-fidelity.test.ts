/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232/#6532: splitting or changing a section must preserve its optional geometry. */
import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProfileSection } from '@ifc-lite/create';
import { getSchemaRegistryForVersion } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { readElementProfile, setElementProfile } from './mutation-element-profile';

const SECTIONS: readonly ProfileSection[] = [
  { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016, FilletRadius: 0.008 },
  { Type: 'L', Depth: 0.1, Width: 0.08, Thickness: 0.01, FilletRadius: 0.004 },
  { Type: 'T', Depth: 0.12, FlangeWidth: 0.12, WebThickness: 0.01, FlangeThickness: 0.012, FilletRadius: 0.004 },
  { Type: 'U', Depth: 0.2, FlangeWidth: 0.075, WebThickness: 0.0085, FlangeThickness: 0.0115, FilletRadius: 0.004 },
  { Type: 'C', Depth: 0.2, Width: 0.07, WallThickness: 0.003, Girth: 0.02, InternalFilletRadius: 0.001 },
  { Type: 'RectangleHollow', XDim: 0.1, YDim: 0.2, WallThickness: 0.008, InnerFilletRadius: 0.004, OuterFilletRadius: 0.012 },
];
const s = () => useViewerStore.getState();
const depth = () => s().undoStacks.get(MODEL_ID)?.length ?? 0;
function beam(Profile: ProfileSection): number {
  const made = s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [6, 0, 3], Profile });
  assert.ok('expressId' in made, 'error' in made ? made.error : '');
  return made.expressId;
}

beforeEach(async () => { await seedModelingSession(); });

describe('optional section geometry survives edits and splits (#6232/#6532)', () => {
  for (const Profile of SECTIONS) {
    it(`${Profile.Type}: both split pieces retain every optional radius`, () => {
      const id = beam(Profile);
      const split = s().splitLinearElementAtDistance(MODEL_ID, id, 2);
      assert.ok(split.ok, split.ok ? '' : split.reason);
      assert.deepEqual(readElementProfile(s(), MODEL_ID, split.left.expressId), Profile);
      assert.deepEqual(readElementProfile(s(), MODEL_ID, split.right.expressId), Profile);
    });
  }

  it('a mandatory dimension edit preserves the existing fillet, and undo restores both', () => {
    const Profile = SECTIONS[0];
    assert.equal(Profile.Type, 'I');
    if (Profile.Type !== 'I') return;
    const id = beam(Profile);
    const current = readElementProfile(s(), MODEL_ID, id);
    assert.ok(current && current.Type === 'I');
    const before = depth();
    assert.deepEqual(setElementProfile(s, MODEL_ID, id, { ...current, OverallDepth: 0.5 }), { ok: true, remesh: [id] });
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), { ...Profile, OverallDepth: 0.5 });
    assert.equal(depth(), before + 1);
    s().undo(MODEL_ID);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), Profile);
  });

  it('an unsupported IFC4 flange slope refuses an edit and split without writes', () => {
    const id = beam(SECTIONS[0]);
    const profile = s().mutationViews.get(MODEL_ID)!.getNewEntities().find((entity) => entity.type === 'IfcIShapeProfileDef');
    assert.ok(profile);
    const fields = getSchemaRegistryForVersion('IFC4').entities.IfcIShapeProfileDef.allAttributes!;
    const slope = fields.findIndex((attribute) => attribute.name === 'FlangeSlope');
    assert.ok(slope >= 0);
    s().setPositionalAttribute(MODEL_ID, profile.expressId, slope, 0.1);
    const before = depth();
    const entities = s().mutationViews.get(MODEL_ID)!.getNewEntities().length;
    assert.equal(readElementProfile(s(), MODEL_ID, id), null);
    assert.equal(setElementProfile(s, MODEL_ID, id, SECTIONS[0]).ok, false);
    assert.equal(s().splitLinearElementAtDistance(MODEL_ID, id, 2).ok, false);
    assert.equal(depth(), before);
    assert.equal(s().mutationViews.get(MODEL_ID)!.getNewEntities().length, entities);
  });

  it('the IFCX-adapted IFC5 rectangle retains existing basic editing and split', () => {
    const dataStore = s().models.get(MODEL_ID)!.ifcDataStore!;
    dataStore.schemaVersion = 'IFC5';
    const result = s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [6, 0, 3], Width: 0.2, Height: 0.4 });
    assert.ok('expressId' in result, 'error' in result ? result.error : '');
    const Profile = { Type: 'Rectangle', XDim: 0.2, YDim: 0.4 } as const;
    assert.deepEqual(readElementProfile(s(), MODEL_ID, result.expressId), Profile);
    const split = s().splitLinearElementAtDistance(MODEL_ID, result.expressId, 2);
    assert.ok(split.ok, split.ok ? '' : split.reason);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, split.left.expressId), Profile);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, split.right.expressId), Profile);
  });

  it('native millimetres preserve optional radii on both split pieces', async () => {
    await seedModelingSession({ unit: 'millimetre' });
    const Profile = SECTIONS[5];
    const id = beam(Profile);
    const split = s().splitLinearElementAtDistance(MODEL_ID, id, 2);
    assert.ok(split.ok, split.ok ? '' : split.reason);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, split.left.expressId), Profile);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, split.right.expressId), Profile);
  });
});
