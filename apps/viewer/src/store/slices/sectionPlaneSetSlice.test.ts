/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cutting-plane set (#7545), through the real store: the active plane stays
 * what every existing writer edits, the rest wait in `inactiveSectionPlanes`,
 * and no action leaves two planes sharing an id, two active planes, or an
 * enabled plane the renderer would not be told about.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { clippingSectionPlanes } from '@/store/section-active';
import { sectionRenderClip } from '@/lib/section/section-render-clip';
import {
  MAX_SECTION_PLANES,
  isPristineSectionPlane,
  orderedSectionPlanes,
  sectionPlaneCount,
} from '@/lib/section/section-plane-set';

const state = () => useViewerStore.getState();
const all = () => orderedSectionPlanes(state().sectionPlane, state().inactiveSectionPlanes);
const names = () => all().map((p) => p.name);

/** The invariants every action must preserve. */
function assertSetIsSound(): void {
  const planes = [state().sectionPlane, ...state().inactiveSectionPlanes];
  assert.equal(new Set(planes.map((p) => p.id)).size, planes.length, 'ids are unique');
  assert.equal(new Set(planes.map((p) => p.name.toLowerCase())).size, planes.length, 'names are unique');
  assert.ok(planes.length <= MAX_SECTION_PLANES, 'never past the limit');
  assert.ok(planes.every((p) => p.id && (p.name || isPristineSectionPlane(p))), 'every plane has an id and a name (only the untouched placeholder is unnamed)');
  // Whatever clips on screen is exactly what the renderer is told about.
  const handed = sectionRenderClip(true, state().sectionPlane, null, 'section', state().inactiveSectionPlanes);
  const cutting = clippingSectionPlanes({ sectionPlane: state().sectionPlane, sceneState: state().sceneState, inactiveSectionPlanes: state().inactiveSectionPlanes });
  const renderable = (handed.sectionPlane?.enabled ? 1 : 0) + (handed.extraSectionPlanes?.length ?? 0);
  assert.equal(renderable, cutting.length, 'the renderer clips against every cutting plane, and no other');
}

beforeEach(() => {
  state().resetViewerState();
  state().setActiveTool('select');
});

describe('a fresh viewer has an untouched placeholder, not a cut', () => {
  it('counts as no planes, and adding takes the placeholder over instead of stacking one behind it', () => {
    assert.equal(sectionPlaneCount(state().sectionPlane, state().inactiveSectionPlanes), 0);
    assert.ok(isPristineSectionPlane(state().sectionPlane));
    const id = state().addSectionPlane('down');
    assert.equal(state().inactiveSectionPlanes.length, 0, 'no ghost plane');
    assert.equal(state().sectionPlane.id, id);
    assert.equal(state().sectionPlane.name, 'A');
    assert.equal(state().sectionPlane.enabled, true);
    assertSetIsSound();
  });
});

describe('adding planes (#7545)', () => {
  it('adds A, B, C in order; each is active, cutting and on its own axis; the earlier ones keep their cut', () => {
    state().addSectionPlane('down');
    state().setSectionPlanePosition(30);
    state().addSectionPlane('side');
    state().setSectionPlanePosition(60);
    state().addSectionPlane('front');
    assert.deepEqual(names(), ['A', 'B', 'C']);
    assert.equal(state().sectionPlane.name, 'C');
    assert.equal(state().sectionPlane.axis, 'front');
    const a = all()[0]!;
    const b = all()[1]!;
    assert.deepEqual([a.axis, a.position, a.enabled], ['down', 30, true]);
    assert.deepEqual([b.axis, b.position, b.enabled], ['side', 60, true]);
    assert.equal(clippingSectionPlanes(state()).length, 3);
    assertSetIsSound();
  });

  it('refuses a ninth plane and says so by returning null', () => {
    for (let i = 0; i < MAX_SECTION_PLANES; i++) assert.ok(state().addSectionPlane('down'));
    assert.equal(state().addSectionPlane('side'), null);
    assert.equal(1 + state().inactiveSectionPlanes.length, MAX_SECTION_PLANES);
    assert.equal(state().armSectionFacePickForNewPlane(), false);
    assert.equal(state().sectionPickMode, false, 'nothing is armed at the limit');
    assertSetIsSound();
  });

  it('a new plane shows the cut again after the hide toggle was off', () => {
    state().addSectionPlane('down');
    state().setSectionVisible(false);
    state().addSectionPlane('side');
    assert.equal(state().sceneState.section.visible, true);
  });
});

describe('activating, renaming, duplicating (#7545)', () => {
  it('activating swaps the planes in one step and keeps creation order for display', () => {
    state().addSectionPlane('down');
    state().addSectionPlane('side');
    state().addSectionPlane('front');
    const aId = all()[0]!.id;
    state().activateSectionPlane(aId);
    assert.equal(state().sectionPlane.name, 'A');
    assert.deepEqual(names(), ['A', 'B', 'C'], 'chips do not reshuffle');
    assert.equal(state().inactiveSectionPlanes.length, 2);
    assertSetIsSound();
  });

  it('existing writers edit only the active plane', () => {
    state().addSectionPlane('down');
    state().addSectionPlane('side');
    state().flipSectionPlane();
    state().setSectionPlanePosition(77);
    const [a, b] = all();
    assert.deepEqual([a!.flipped, a!.position], [false, 50], 'A untouched');
    assert.deepEqual([b!.flipped, b!.position], [true, 77]);
    state().activateSectionPlane(a!.id);
    state().flipSectionPlane();
    assert.equal(all()[1]!.flipped, true, 'B untouched by the edit to A');
  });

  it('renames with trim, a length bound and a unique suffix; empty is ignored', () => {
    state().addSectionPlane('down');
    state().addSectionPlane('side');
    const [a, b] = all();
    state().renameSectionPlane(b!.id, '  East wing  ');
    assert.equal(all()[1]!.name, 'East wing');
    state().renameSectionPlane(a!.id, 'east WING');
    assert.equal(all()[0]!.name, 'east WING 2', 'a clash gets a suffix, case-insensitively');
    state().renameSectionPlane(a!.id, '   ');
    assert.equal(all()[0]!.name, 'east WING 2', 'blank is ignored');
    state().renameSectionPlane(a!.id, 'x'.repeat(60));
    assert.equal(all()[0]!.name.length, 24);
    assertSetIsSound();
  });

  it('duplicates into a new active plane that is free of an alignment binding', () => {
    state().addSectionPlane('down');
    const source = state().sectionPlane;
    const id = state().duplicateSectionPlane(source.id);
    assert.ok(id && id !== source.id);
    assert.equal(state().sectionPlane.id, id);
    assert.equal(state().sectionPlane.position, source.position);
    assert.equal(state().sectionPlane.name, 'A copy');
    assertSetIsSound();
  });
});

describe('removing and clearing with Undo (#7545)', () => {
  it('removing the active plane activates the one before it; Undo brings it back', () => {
    state().addSectionPlane('down');
    state().addSectionPlane('side');
    state().addSectionPlane('front');
    const b = all()[1]!;
    state().activateSectionPlane(b.id);
    state().removeSectionPlane(b.id);
    assert.deepEqual(names(), ['A', 'C']);
    assert.equal(state().sectionPlane.name, 'A', 'the previous plane in creation order');
    assert.equal(state().sectionUndo?.label, 'removed');
    assertSetIsSound();
    state().undoSectionChange();
    assert.deepEqual(names(), ['A', 'B', 'C']);
    assert.equal(state().sectionPlane.name, 'B');
    assert.equal(state().sectionUndo, null);
  });

  it('removing an inactive plane leaves the active one alone', () => {
    state().addSectionPlane('down');
    state().addSectionPlane('side');
    const [a] = all();
    state().removeSectionPlane(a!.id);
    assert.deepEqual(names(), ['B']);
    assert.equal(state().sectionPlane.name, 'B');
  });

  it('removing the last plane leaves a placeholder (no cut), not an empty set', () => {
    state().addSectionPlane('down');
    state().removeSectionPlane(state().sectionPlane.id);
    assert.equal(sectionPlaneCount(state().sectionPlane, state().inactiveSectionPlanes), 0);
    assert.equal(clippingSectionPlanes(state()).length, 0);
    assertSetIsSound();
  });

  it('Clear all clears everything, Undo restores the whole set, and a new edit drops the record', () => {
    state().addSectionPlane('down');
    state().addSectionPlane('side');
    state().addSectionPlane('front');
    state().clearSectionPlanes();
    assert.equal(sectionPlaneCount(state().sectionPlane, state().inactiveSectionPlanes), 0);
    assert.equal(state().sectionUndo?.label, 'cleared');
    state().undoSectionChange();
    assert.deepEqual(names(), ['A', 'B', 'C']);
    state().clearSectionPlanes();
    state().addSectionPlane('down');
    assert.equal(state().sectionUndo, null, 'the record is stale once the set changes again');
  });

  it('Clear all on an untouched placeholder records nothing', () => {
    state().clearSectionPlanes();
    assert.equal(state().sectionUndo, null);
  });
});

describe('cutting and showing an inactive plane (#7545)', () => {
  it('turns an inactive plane off and on without activating it, and the renderer follows', () => {
    state().addSectionPlane('down');
    state().addSectionPlane('side');
    const a = all()[0]!;
    state().setSectionPlaneCutting(a.id, false);
    assert.equal(state().sectionPlane.name, 'B', 'still active');
    assert.equal(clippingSectionPlanes(state()).length, 1);
    state().setSectionPlaneCutting(a.id, true);
    assert.equal(clippingSectionPlanes(state()).length, 2);
    assertSetIsSound();
  });

  it('showGizmo is per plane and does not change cutting', () => {
    state().addSectionPlane('down');
    state().addSectionPlane('side');
    const a = all()[0]!;
    state().setSectionPlaneShowGizmo(a.id, false);
    assert.equal(all()[0]!.showGizmo, false);
    assert.equal(all()[0]!.enabled, true);
    assert.equal(all()[1]!.showGizmo, true);
  });
});

describe('the face pick can add a plane (#7545)', () => {
  const pick = () => state().setSectionPlaneFromFace([0, 0, 1], [1, 2, 3]);

  it('an armed add-pick appends a face plane and keeps the existing cut; a plain pick still replaces', () => {
    state().addSectionPlane('down');
    assert.equal(state().armSectionFacePickForNewPlane(), true);
    assert.equal(state().sectionPickTarget, 'new');
    pick();
    assert.equal(1 + state().inactiveSectionPlanes.length, 2);
    assert.ok(state().sectionPlane.custom, 'the new plane is the face plane');
    assert.equal(state().sectionPlane.name, 'B');
    assert.equal(state().inactiveSectionPlanes[0]!.axis, 'down', 'the earlier plane keeps its cut');
    assert.equal(state().sectionPickTarget, 'replace', 'the target is spent with the pick');
    assertSetIsSound();

    state().setSectionPickMode(true);
    pick();
    assert.equal(1 + state().inactiveSectionPlanes.length, 2, 'a plain pick replaces the active plane');
  });

  it('a degenerate pick adds nothing and disarms', () => {
    state().addSectionPlane('down');
    state().armSectionFacePickForNewPlane();
    state().setSectionPlaneFromFace([0, 0, 0], [1, 2, 3]);
    assert.equal(1 + state().inactiveSectionPlanes.length, 1);
    assert.equal(state().sectionPickMode, false);
  });

  it('disarming drops the add target, and activating another plane cancels a pending pick', () => {
    state().addSectionPlane('down');
    state().addSectionPlane('side');
    state().armSectionFacePickForNewPlane();
    state().setSectionPickMode(false);
    assert.equal(state().sectionPickTarget, 'replace');
    state().armSectionFacePickForNewPlane();
    state().activateSectionPlane(all()[0]!.id);
    assert.equal(state().sectionPickMode, false);
    assert.equal(state().sectionPickTarget, 'replace');
  });

  it('picking on an untouched placeholder uses it instead of adding a ghost', () => {
    assert.equal(state().armSectionFacePickForNewPlane(), true);
    pick();
    assert.equal(state().inactiveSectionPlanes.length, 0);
    assert.equal(state().sectionPlane.name, 'A');
  });
});

describe('installing a whole set (saved sets, viewpoints) (#7545)', () => {
  it('replaces the set, keeps the order, picks the active plane and gives fresh unique ids and names', () => {
    state().addSectionPlane('down');
    const before = new Set(all().map((p) => p.id));
    const incoming = [
      { ...state().sectionPlane, name: 'Floor', position: 20 },
      { ...state().sectionPlane, name: 'Floor', position: 80, axis: 'side' as const },
    ];
    state().installSectionPlanes(incoming, 1);
    assert.deepEqual(names(), ['Floor', 'Floor 2']);
    assert.equal(state().sectionPlane.position, 80);
    assert.ok(all().every((p) => !before.has(p.id)), 'ids are regenerated, never reused');
    assertSetIsSound();
  });

  it('clamps an out-of-range active index and ignores an empty list', () => {
    state().addSectionPlane('down');
    state().installSectionPlanes([], 0);
    assert.equal(all().length, 1);
    state().installSectionPlanes([state().sectionPlane, { ...state().sectionPlane, name: 'Z' }], 99);
    assert.equal(state().sectionPlane.name, 'Z');
  });
});

describe('the set resets with the model (#7545)', () => {
  it('a session reset drops every plane and the Undo that would bring them back', () => {
    state().addSectionPlane('down');
    state().addSectionPlane('side');
    state().clearSectionPlanes();
    state().resetViewerState();
    assert.equal(state().inactiveSectionPlanes.length, 0);
    assert.equal(state().sectionUndo, null);
    assert.equal(sectionPlaneCount(state().sectionPlane, state().inactiveSectionPlanes), 0);
  });
});
