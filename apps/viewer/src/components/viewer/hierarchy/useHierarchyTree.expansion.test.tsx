/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useHierarchyTree } from './useHierarchyTree';

// The idle build is held until a test releases it, so "before idle" is a
// state the test controls rather than a race against a timer.
type IdleGlobal = typeof globalThis & {
  requestIdleCallback?: (callback: IdleRequestCallback) => number;
  cancelIdleCallback?: (handle: number) => void;
};
const idleGlobal = globalThis as IdleGlobal;
const realIdle = { request: idleGlobal.requestIdleCallback, cancel: idleGlobal.cancelIdleCallback };
let heldIdle: (() => void) | null = null;
const releaseIdle = () => act(() => { const task = heldIdle; heldIdle = null; task?.(); });
beforeEach(() => {
  heldIdle = null;
  idleGlobal.requestIdleCallback = (callback: IdleRequestCallback) => { heldIdle = () => callback({ didTimeout: false, timeRemaining: () => 50 }); return 1; };
  idleGlobal.cancelIdleCallback = () => { heldIdle = null; };
});
afterEach(() => {
  cleanup();
  idleGlobal.requestIdleCallback = realIdle.request;
  idleGlobal.cancelIdleCallback = realIdle.cancel;
});

/** A two-wall class model whose entity-row reads are counted (the builder's membership scan). */
function countedClassModel(id: string) {
  const model = fixtureModel(id, { entities: [
    { expressId: 7, type: 'IfcWall', name: 'Wall A' },
    { expressId: 8, type: 'IfcWall', name: 'Wall B' },
  ] });
  const entities = model.ifcDataStore!.entities;
  const expressIds = entities.expressId;
  const counter = { scans: 0 };
  Object.defineProperty(entities, 'expressId', {
    configurable: true,
    get() { counter.scans++; return expressIds; },
  });
  const models = fixtureModels(model).models;
  useViewerStore.setState({ ...fixtureModels(model), hierarchyMode: 'type', loading: false });
  let tree!: ReturnType<typeof useHierarchyTree>;
  function Probe() {
    tree = useHierarchyTree({ models, ifcDataStore: null, isMultiModel: false });
    return null;
  }
  render(<Probe />);
  return { counter, tree: () => tree };
}

it('keeps the #5886 class builder invocation count at one through repeated expansion toggles, before and after idle', () => {
  const { counter, tree } = countedClassModel('expansion-model');
  assert.equal(tree().treeData.length, 1, 'the class group starts collapsed');
  assert.ok(counter.scans > 0, 'the visible rows were built from real entity rows');
  assert.ok(heldIdle, 'the complete structure is deferred to idle, not built in the first commit (NEW-4)');

  // Before idle: the first toggle builds the complete structure once, every
  // later toggle only projects it (#9629 review: it used to rescan per toggle).
  act(() => tree().toggleExpand('type-IfcWall'));
  assert.equal(tree().treeData.length, 3);
  const builtScans = counter.scans;
  for (let i = 1; i < 8; i++) {
    act(() => tree().toggleExpand('type-IfcWall'));
    assert.equal(tree().treeData.length, i % 2 === 0 ? 3 : 1, 'only the visible row projection changes');
  }
  assert.equal(counter.scans, builtScans, 'expansion before idle must not invoke the class builder again');

  releaseIdle();
  for (let i = 0; i < 4; i++) act(() => tree().toggleExpand('type-IfcWall'));
  assert.equal(counter.scans, builtScans, 'idle has nothing left to build, and toggles still only project');

  act(() => tree().setSearchQuery('Wall B'));
  assert.ok(tree().filteredNodes.some((node) => node.name === 'Wall B'), 'search sees the complete structure');
  assert.equal(counter.scans, builtScans, 'search must reuse the same structure');

  act(() => tree().setSearchQuery(''));
  let revealed: string | null = null;
  act(() => { revealed = tree().revealGlobalId(8); });
  assert.ok(revealed, 'an external selection resolves to the full-tree leaf');
  assert.equal(counter.scans, builtScans, 'reveal must reuse the same structure');
});

it('builds the complete structure at idle when nothing asked for it first (NEW-4)', () => {
  const { counter, tree } = countedClassModel('idle-model');
  const beforeIdle = counter.scans;
  releaseIdle();
  assert.ok(counter.scans > beforeIdle, 'the idle task built the structure');
  const built = counter.scans;
  for (let i = 0; i < 8; i++) act(() => tree().toggleExpand('type-IfcWall'));
  assert.equal(counter.scans, built, 'expansion after idle only projects');
});

it('builds the complete structure once, on demand, when search runs before idle (NEW-4)', () => {
  const { counter, tree } = countedClassModel('search-first-model');
  act(() => tree().setSearchQuery('Wall B'));
  assert.ok(tree().filteredNodes.some((node) => node.name === 'Wall B'), 'search sees the complete structure at once');
  const afterSearch = counter.scans;
  act(() => tree().setSearchQuery('Wall'));
  act(() => tree().setSearchQuery(''));
  let revealed: string | null = null;
  act(() => { revealed = tree().revealGlobalId(8); });
  assert.ok(revealed, 'reveal resolves against the same structure');
  releaseIdle();
  assert.equal(counter.scans, afterSearch, 'search, reveal and idle reuse the structure the first search built');
});
