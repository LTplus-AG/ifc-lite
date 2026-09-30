/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A beam's, column's or member's cross-section, read and changed (#6232 D2):
 * each kind is written as its IFC profile class, a rectangle turned into an I
 * is one undo step that undo puts back exactly, an unreadable layout is
 * refused, and a piece of a split I-beam is an I-beam.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { MODEL_ID, ROTATED_BEAM, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { setElementProfileSection } from '@/components/viewer/model-inspector/inspector-edits';
import type { ProfileSection } from '@ifc-lite/create';
import { readElementProfile, setElementProfile } from './mutation-element-profile';

const s = () => useViewerStore.getState();
const made = (m: { expressId: number } | { error: string }): number => { assert.ok('expressId' in m, 'error' in m ? m.error : ''); return m.expressId; };
const undoDepth = () => s().undoStacks.get(MODEL_ID)?.length ?? 0;

/** The body profile of an authored element as it reads now (positional edits over the overlay): its IFC class. */
function profileClassOf(id: number): string {
  const view = s().mutationViews.get(MODEL_ID)!;
  const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
  const ref = (v: unknown) => byId.get(Number(String(v).slice(1)))!;
  const shape = ref(byId.get(id)!.attributes[6]);
  const solid = ref((ref((shape.attributes[2] as string[])[0]).attributes[3] as string[])[0]);
  const swept = view.getPositionalMutationsForEntity(solid.expressId)?.get(0) ?? solid.attributes[0];
  return ref(swept).type.toUpperCase();
}

const I: ProfileSection = { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 };

let restoreRemesh: () => void = () => {};
beforeEach(async () => {
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
});
afterEach(() => { restoreRemesh(); s().exitModelWorkspace(); });

const beam = () => made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [6, 0, 3], Width: 0.3, Height: 0.5 }));

describe('readElementProfile / setElementProfile (#6232 D2)', () => {
  it('reads a rectangle as a Rectangle section, and a profiled beam as its section', () => {
    const plain = beam();
    assert.deepEqual(readElementProfile(s(), MODEL_ID, plain), { Type: 'Rectangle', XDim: 0.3, YDim: 0.5 });
    const steel = made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 2, 3], End: [6, 2, 3], Profile: I }));
    assert.deepEqual(readElementProfile(s(), MODEL_ID, steel), I);
  });

  const KINDS: Array<[ProfileSection, string]> = [
    [{ Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 }, 'IFCISHAPEPROFILEDEF'],
    [{ Type: 'L', Depth: 0.1, Width: 0.08, Thickness: 0.01 }, 'IFCLSHAPEPROFILEDEF'],
    [{ Type: 'T', FlangeWidth: 0.12, Depth: 0.12, WebThickness: 0.01, FlangeThickness: 0.012 }, 'IFCTSHAPEPROFILEDEF'],
    [{ Type: 'U', Depth: 0.2, FlangeWidth: 0.075, WebThickness: 0.0085, FlangeThickness: 0.0115 }, 'IFCUSHAPEPROFILEDEF'],
    [{ Type: 'C', Depth: 0.2, Width: 0.07, WallThickness: 0.003, Girth: 0.02 }, 'IFCCSHAPEPROFILEDEF'],
    [{ Type: 'Circle', Radius: 0.15 }, 'IFCCIRCLEPROFILEDEF'],
    [{ Type: 'RectangleHollow', XDim: 0.1, YDim: 0.2, WallThickness: 0.008 }, 'IFCRECTANGLEHOLLOWPROFILEDEF'],
    [{ Type: 'CircleHollow', Radius: 0.1, WallThickness: 0.008 }, 'IFCCIRCLEHOLLOWPROFILEDEF'],
  ];
  for (const [section, cls] of KINDS) {
    it(`a rectangle becomes ${cls}, read back as the same section, one undo step`, () => {
      const id = beam();
      const before = undoDepth();
      const outcome = setElementProfile(() => s(), MODEL_ID, id, section);
      assert.deepEqual(outcome, { ok: true, remesh: [id] });
      assert.equal(profileClassOf(id), cls);
      assert.deepEqual(readElementProfile(s(), MODEL_ID, id), section);
      assert.equal(undoDepth() - before, 1, 'one mutation: the extrusion points at the new profile');
    });
  }

  it('changing the profile from the inspector is ONE undo step that puts the rectangle back, and redo the I', () => {
    const id = beam();
    const before = undoDepth();
    assert.equal(setElementProfileSection(MODEL_ID, id, I), true);
    assert.equal(profileClassOf(id), 'IFCISHAPEPROFILEDEF');
    const tags = new Set(s().undoStacks.get(MODEL_ID)!.slice(before).map((m) => s().mutationBatchTags.get(m.id)));
    assert.equal(tags.size, 1, 'the whole edit is one batch');
    s().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'a single undo unwinds it');
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), { Type: 'Rectangle', XDim: 0.3, YDim: 0.5 });
    s().redo(MODEL_ID);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), I);
  });

  it('changing one dimension of an I keeps it an I and undoes to the earlier size', () => {
    const id = made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [6, 0, 3], Profile: I }));
    assert.equal(setElementProfileSection(MODEL_ID, id, { ...I, OverallDepth: 0.3 }), true);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), { ...I, OverallDepth: 0.3 });
    s().undo(MODEL_ID);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), I);
  });

  it('a rectangle resized as a rectangle writes the two sides in place, no new profile', () => {
    const id = beam();
    const entities = s().mutationViews.get(MODEL_ID)!.getNewEntities().length;
    assert.deepEqual(setElementProfile(() => s(), MODEL_ID, id, { Type: 'Rectangle', XDim: 0.25, YDim: 0.6 }), { ok: true, remesh: [id] });
    assert.equal(s().mutationViews.get(MODEL_ID)!.getNewEntities().length, entities);
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), { Type: 'Rectangle', XDim: 0.25, YDim: 0.6 });
  });

  it('the same section writes nothing', () => {
    const id = made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [6, 0, 3], Profile: I }));
    const before = undoDepth();
    assert.deepEqual(setElementProfile(() => s(), MODEL_ID, id, I), { ok: true, remesh: [] });
    assert.equal(undoDepth(), before);
  });

  it('a column takes a profile the same way', () => {
    const id = made(s().addColumn(MODEL_ID, STOREY, { Position: [1, 1, 0], Width: 0.4, Depth: 0.4, Height: 3 }));
    assert.equal(setElementProfileSection(MODEL_ID, id, { Type: 'CircleHollow', Radius: 0.15, WallThickness: 0.01 }), true);
    assert.equal(profileClassOf(id), 'IFCCIRCLEHOLLOWPROFILEDEF');
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), { Type: 'CircleHollow', Radius: 0.15, WallThickness: 0.01 });
  });

  it('refuses a section the builders refuse, and writes nothing', () => {
    const id = beam();
    const before = undoDepth();
    const outcome = setElementProfile(() => s(), MODEL_ID, id, { ...I, WebThickness: 0.5 });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { reason: string }).reason, /WebThickness must be less than OverallWidth/);
    assert.equal(setElementProfileSection(MODEL_ID, id, { ...I, WebThickness: 0.5 }), false);
    assert.equal(undoDepth(), before);
  });

  it('refuses an imported beam laid out off the builders\' layout', () => {
    assert.equal(readElementProfile(s(), MODEL_ID, ROTATED_BEAM), null);
    const outcome = setElementProfile(() => s(), MODEL_ID, ROTATED_BEAM, I);
    assert.equal(outcome.ok, false);
  });

  it('a piece cut from an I-beam is an I-beam, not a rectangle', () => {
    const id = made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [6, 0, 3], Profile: I }));
    const split = s().splitLinearElementAtDistance(MODEL_ID, id, 2);
    assert.ok(split.ok, split.ok ? '' : split.reason);
    for (const piece of [split.left.expressId, split.right.expressId]) {
      assert.deepEqual(readElementProfile(s(), MODEL_ID, piece), I);
    }
  });
});

describe('setElementProfile in a millimetre model (#6232 D2)', () => {
  it('writes the section in the file\'s unit and reads it back in metres', async () => {
    await seedModelingSession({ unit: 'millimetre' });
    const id = beam();
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), { Type: 'Rectangle', XDim: 0.3, YDim: 0.5 });
    assert.equal(setElementProfileSection(MODEL_ID, id, I), true);
    const view = s().mutationViews.get(MODEL_ID)!;
    const ids = view.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCISHAPEPROFILEDEF');
    assert.deepEqual(ids.map((e) => e.attributes.slice(3, 7).map((v) => (typeof v === 'object' && v !== null && 'real' in v ? (v as { real: number }).real : v))), [[200, 400, 10, 16]], 'native millimetres');
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), I);
  });
});
