/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's Profile section (#6232 D2), driven the way a user
 * does: select a placed beam, column or member, pick another section kind or
 * type a dimension. Each change is ONE undo step and shows the old section
 * again after it; a new kind keeps the element's outer size; Defaults mode
 * edits what the next element is built with.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { blur, click, cleanup, render, type } from '@/test/render.js';
import { MODEL_ID, ROTATED_BEAM, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin.js';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import { ModelInspectorPanel } from './ModelInspectorPanel.js';

const s = () => useViewerStore.getState();
const undoDepth = () => s().undoStacks.get(MODEL_ID)?.length ?? 0;
const made = (m: { expressId: number } | { error: string }): number => { assert.ok('expressId' in m, 'error' in m ? m.error : ''); return m.expressId; };
const select = (expressId: number) => act(() => s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, expressId)));
const kindButton = (root: HTMLElement, kind: string) => root.querySelector(`[data-profile-kind-button="${kind}"]`) as HTMLButtonElement;
const field = (root: HTMLElement, label: string) => {
  const found = [...root.querySelectorAll('[data-profile-editor] input')].find((el) => el.getAttribute('aria-label') === label);
  assert.ok(found, `a Profile field "${label}"`);
  return found as HTMLInputElement;
};
const headings = (root: HTMLElement) => [...root.querySelectorAll('h3')].map((h) => h.textContent);

let restoreRemesh: () => void;
beforeEach(async () => {
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
  s().setAuthoringDefaults({ profiles: { beam: { type: 'Rectangle', dims: {} }, member: { type: 'Rectangle', dims: {} }, column: { type: 'Rectangle', dims: {} } } });
  assert.equal(s().enterModelWorkspace(), true);
});
afterEach(() => {
  cleanup();
  s().exitModelWorkspace();
  restoreRemesh();
});

describe('ModelInspectorPanel Profile section (#6232 D2)', () => {
  it('switching a placed rectangle beam to an I keeps its outer size, is one undo step, and undo restores the rectangle', () => {
    const beam = made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [6, 0, 3], Width: 0.3, Height: 0.5 }));
    select(beam);
    const root = render(<ModelInspectorPanel />);
    assert.ok(headings(root).includes('Profile'));
    assert.equal(kindButton(root, 'Rectangle').getAttribute('aria-pressed'), 'true');
    const depth = undoDepth();
    act(() => click(kindButton(root, 'I')));
    assert.equal(kindButton(root, 'I').getAttribute('aria-pressed'), 'true');
    const section = readElementProfile(s(), MODEL_ID, beam);
    assert.equal(section?.Type, 'I');
    assert.deepEqual([(section as { OverallWidth: number }).OverallWidth, (section as { OverallDepth: number }).OverallDepth], [0.3, 0.5], 'the I is as wide and deep as the rectangle was');
    const tags = new Set(s().undoStacks.get(MODEL_ID)!.slice(depth).map((m) => s().mutationBatchTags.get(m.id)));
    assert.equal(tags.size, 1, 'one batch');
    act(() => s().undo(MODEL_ID));
    assert.equal(undoDepth(), depth, 'one undo');
    assert.deepEqual(readElementProfile(s(), MODEL_ID, beam), { Type: 'Rectangle', XDim: 0.3, YDim: 0.5 });
    assert.equal(kindButton(root, 'Rectangle').getAttribute('aria-pressed'), 'true', 'the picker shows the rectangle again');
  });

  it('a typed dimension of an I is one undo step; one the section cannot hold is refused', () => {
    const beam = made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [6, 0, 3], Profile: { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 } }));
    select(beam);
    const root = render(<ModelInspectorPanel />);
    const depth = undoDepth();
    const web = field(root, 'Web in metres');
    type(web, '0.012'); blur(web);
    assert.equal((readElementProfile(s(), MODEL_ID, beam) as { WebThickness: number }).WebThickness, 0.012);
    assert.ok(undoDepth() > depth);
    const tags = new Set(s().undoStacks.get(MODEL_ID)!.slice(depth).map((m) => s().mutationBatchTags.get(m.id)));
    assert.equal(tags.size, 1, 'one batch');
    act(() => s().undo(MODEL_ID));
    assert.equal(undoDepth(), depth, 'one undo');
    assert.equal((readElementProfile(s(), MODEL_ID, beam) as { WebThickness: number }).WebThickness, 0.01);
    const refused = field(root, 'Web in metres');
    const before = undoDepth();
    type(refused, '0.5'); blur(refused);
    assert.equal(undoDepth(), before, 'nothing written');
    assert.equal((readElementProfile(s(), MODEL_ID, beam) as { WebThickness: number }).WebThickness, 0.01);
    assert.equal(field(root, 'Web in metres').value, '0.01', 'the field reverts');
  });

  it('a column switches to a hollow circle', () => {
    const column = made(s().addColumn(MODEL_ID, STOREY, { Position: [1, 1, 0], Width: 0.4, Depth: 0.4, Height: 3 }));
    select(column);
    const root = render(<ModelInspectorPanel />);
    act(() => click(kindButton(root, 'CircleHollow')));
    const section = readElementProfile(s(), MODEL_ID, column);
    assert.equal(section?.Type, 'CircleHollow');
    assert.equal((section as { Radius: number }).Radius, 0.2, 'the tube is as wide as the 0.4 column');
    assert.ok(field(root, 'Wall in metres'));
  });

  it('a member has the section too', () => {
    const member = made(s().addMember(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [3, 0, 2], Width: 0.1, Height: 0.1 }));
    select(member);
    const root = render(<ModelInspectorPanel />);
    act(() => click(kindButton(root, 'L')));
    assert.equal(readElementProfile(s(), MODEL_ID, member)?.Type, 'L');
  });

  it('an imported beam off the builders\' layout has no editable profile, and says so', () => {
    select(ROTATED_BEAM);
    const root = render(<ModelInspectorPanel />);
    assert.equal(root.querySelector('[data-profile-editor]'), null);
    assert.match(root.textContent ?? '', /built straight from a section/);
  });

  it('Defaults mode edits the section the next element gets, and drops the rectangle\'s own sides', () => {
    s().startCommand('column.place');
    const root = render(<ModelInspectorPanel />);
    assert.ok(headings(root).includes('Profile'));
    assert.deepEqual(['Width in metres', 'Depth in metres', 'Height in metres'].map((l) => [...root.querySelectorAll('input')].some((i) => i.getAttribute('aria-label') === l)), [true, true, true]);
    act(() => click(kindButton(root, 'I')));
    assert.equal(s().authoringDefaults.profiles.column.type, 'I');
    const labels = [...root.querySelectorAll('input')].map((i) => i.getAttribute('aria-label'));
    assert.equal(labels.includes('Depth in metres') && labels.filter((l) => l === 'Depth in metres').length, 1, 'only the I\'s own Depth, not the rectangle\'s');
    assert.ok(labels.includes('Height in metres'));
  });
});
