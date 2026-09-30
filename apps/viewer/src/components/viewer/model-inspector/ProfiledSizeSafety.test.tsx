/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A profiled beam or column (I, hollow circle, ...) through the rectangle's
 * size writes (#6232 D2, on top of C4): an I's attributes 3 and 4 are
 * OverallWidth and OverallDepth, a hollow circle's are Radius and WallThickness,
 * so the rectangle's XDim / YDim write must never reach them. The inspector's
 * Dimensions rows show the outer size read-only and keep the length editable;
 * push / pull offers the length faces only; `setElementSize` refuses a side.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { ProfileSection } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { blur, cleanup, render, type } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { commitElementSize } from '@/lib/element-size-commit';
import { readPushPullTarget } from '@/lib/push-pull/push-pull-target';
import { setElementSize } from '@/store/slices/mutation-element-size';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import { ModelInspectorPanel } from './ModelInspectorPanel.js';

const s = () => useViewerStore.getState();
const undoDepth = () => s().undoStacks.get(MODEL_ID)?.length ?? 0;
const made = (m: { expressId: number } | { error: string }): number => { assert.ok('expressId' in m, 'error' in m ? m.error : ''); return m.expressId; };
const select = (expressId: number) => act(() => s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, expressId)));
const input = (root: HTMLElement, label: string) => {
  const found = [...root.querySelectorAll('input')].find((el) => el.getAttribute('aria-label') === label);
  assert.ok(found, `an input labelled "${label}"`);
  return found as HTMLInputElement;
};
/** Every positional write on any overlay entity: none may be a profile's attribute 3 or 4. */
function profileWrites(): number {
  const view = s().mutationViews.get(MODEL_ID)!;
  return view.getNewEntities()
    .filter((e) => /PROFILEDEF$/i.test(e.type))
    .filter((e) => { const m = view.getPositionalMutationsForEntity(e.expressId); return !!m && (m.has(3) || m.has(4)); })
    .length;
}

const I: ProfileSection = { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 };
const TUBE: ProfileSection = { Type: 'CircleHollow', Radius: 0.15, WallThickness: 0.01 };

let restoreRemesh: () => void;
beforeEach(async () => {
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
  assert.equal(s().enterModelWorkspace(), true);
});
afterEach(() => { cleanup(); s().exitModelWorkspace(); restoreRemesh(); });

const beam = () => made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [4, 0, 3], Profile: I }));
const column = () => made(s().addColumn(MODEL_ID, STOREY, { Position: [2, 2, 0], Profile: TUBE, Height: 3 }));

describe('a profiled beam or column through the rectangle size writes (#6232 D2)', () => {
  it('setElementSize refuses a section side and writes nothing; the length is still edited', () => {
    for (const [id, section] of [[beam(), I], [column(), TUBE]] as const) {
      const before = undoDepth();
      for (const patch of [{ width: 0.5 }, { cross: 0.7 }, { width: 0.5, cross: 0.7 }] as const) {
        const outcome = setElementSize(useViewerStore, MODEL_ID, id, { kind: 'linear', ...patch });
        assert.equal(outcome.ok, false);
        assert.match((outcome as { reason: string }).reason, /Profile section/);
      }
      assert.equal(undoDepth(), before, 'nothing written');
      assert.deepEqual(readElementProfile(s(), MODEL_ID, id), section);
      assert.equal(setElementSize(useViewerStore, MODEL_ID, id, { kind: 'linear', length: 6 }).ok, true);
      assert.deepEqual(readElementProfile(s(), MODEL_ID, id), section, 'the length leaves the section as it was');
    }
    assert.equal(profileWrites(), 0);
  });

  it('the inspector shows an I-beam\'s outer size read-only and keeps its Length editable', () => {
    const id = beam();
    select(id);
    const root = render(<ModelInspectorPanel />);
    assert.deepEqual(['Length', 'Width', 'Height'].map((l) => input(root, `${l} in metres`).readOnly), [false, true, true]);
    assert.deepEqual(['Length', 'Width', 'Height'].map((l) => input(root, `${l} in metres`).value), ['4.00', '0.20', '0.40']);
    const width = input(root, 'Width in metres');
    const depth = undoDepth();
    type(width, '0.5'); blur(width);
    assert.equal(undoDepth(), depth, 'a typed side writes nothing');
    const length = input(root, 'Length in metres');
    type(length, '5.5'); blur(length);
    assert.equal(undoDepth() - depth, 1, 'the length is one undo step');
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), I);
    assert.equal(profileWrites(), 0);
  });

  it('the inspector shows a hollow column\'s Width and Depth read-only and keeps its Height editable', () => {
    const id = column();
    select(id);
    const root = render(<ModelInspectorPanel />);
    assert.deepEqual(['Width', 'Depth', 'Height'].map((l) => input(root, `${l} in metres`).readOnly), [true, true, false]);
    const height = input(root, 'Height in metres');
    type(height, '4'); blur(height);
    assert.equal(input(root, 'Height in metres').value, '4.00');
    assert.deepEqual(readElementProfile(s(), MODEL_ID, id), TUBE);
    assert.equal(profileWrites(), 0);
  });

  it('a rectangle keeps every row editable', () => {
    const id = made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.3 }));
    select(id);
    const root = render(<ModelInspectorPanel />);
    assert.deepEqual(['Length', 'Width', 'Height'].map((l) => input(root, `${l} in metres`).readOnly), [false, false, false]);
  });

  it('push / pull offers a profiled element its length faces only, and pulling one leaves the section', () => {
    for (const [id, section] of [[beam(), I], [column(), TUBE]] as const) {
      const target = readPushPullTarget(s(), MODEL_ID, id);
      assert.ok(target, 'a profiled element can be pushed and pulled');
      assert.deepEqual(target.faces.map((f) => f.id).sort(), ['linear.end', 'linear.start']);
      const end = target.faces.find((f) => f.id === 'linear.end')!;
      assert.equal(commitElementSize(useViewerStore, MODEL_ID, id, end.patch(end.size + 1)).ok, true);
      assert.deepEqual(readElementProfile(s(), MODEL_ID, id), section);
    }
    assert.equal(profileWrites(), 0);
  });
});
