/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source-level wiring tests for the advanced Filter tab's "Isolate in 3D"
 * action (`handleIsolateResult`).
 *
 * Same rationale as `handleRowClick`'s wiring test (PR #2396):
 * `SearchModalFilter` reads the store directly and renders a virtualized
 * table, so it cannot be mounted under `tsx --test`, and this repo rejects
 * `mock.module`. What matters here is not the isolation logic itself
 * (covered by `isolate-filter-result.test.ts`'s pure
 * `collectFilterResultGlobalIds` tests) but WIRING — the same class of bug
 * PR #2396 fixed for row-click: select without clearing the stale
 * multi-selection, or isolate without framing, or frame behind a
 * full-screen scrim because the modal never closes.
 *
 * The ordering assertion is the load-bearing one: `setSelectedEntityIds([])`
 * also resets `selectedEntityId` (HierarchyPanel.tsx:410-411), so clearing
 * AFTER selecting the isolated set would silently throw the selection away
 * and frame nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'SearchModal.filter.tsx'), 'utf8');

/**
 * Strip `//` line comments. Without this these tests are VACUOUS: the
 * handler's own comments quote the very calls being asserted (e.g.
 * "`setSelectedEntityIds([])` also resets `selectedEntityId`"), so a naive
 * `indexOf` matches the comment rather than the statement — and since the
 * comment sits above both calls, the ordering assertion passes no matter
 * how the real statements are ordered. Verified by mutation: swapping the
 * two calls left all assertions green until comments were stripped.
 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** The body of `handleIsolateResult`, from its declaration to the dependency array. */
function handleIsolateResultBody(): string {
  const start = source.indexOf('const handleIsolateResult = useCallback(');
  assert.notEqual(start, -1, 'handleIsolateResult must exist in SearchModal.filter.tsx');
  const end = source.indexOf('}, [', start);
  assert.notEqual(end, -1, 'handleIsolateResult must end with a dependency array');
  const body = stripLineComments(source.slice(start, end));
  // Guard the guard: if the stripping ever removes the statements themselves,
  // every assertion below would fail loudly rather than silently pass.
  assert.ok(body.includes('isolateEntities('), 'stripped body must retain the isolate call');
  return body;
}

describe('advanced Filter tab: "Isolate in 3D" wiring', () => {
  test('the toolbar renders an Isolate in 3D button beside Create list and Export, matching their guard/style', () => {
    const listBtnStart = source.indexOf('onClick={handleCreateList}');
    assert.notEqual(listBtnStart, -1, 'Create list button must exist');
    const isolateBtnStart = source.indexOf('onClick={handleIsolateResult}');
    assert.notEqual(isolateBtnStart, -1, 'Isolate in 3D button must exist');
    assert.ok(isolateBtnStart > listBtnStart, 'Isolate in 3D must sit beside/after Create list in the toolbar');

    // Pull the enclosing <Button ...>...</Button> block for the new action.
    const blockStart = source.lastIndexOf('<Button', isolateBtnStart);
    const blockEnd = source.indexOf('</Button>', isolateBtnStart);
    const block = source.slice(blockStart, blockEnd);

    assert.ok(block.includes("variant=\"ghost\""), 'must match the neighbouring buttons’ ghost variant');
    assert.ok(block.includes("size=\"sm\""), 'must match the neighbouring buttons’ sm size');
    assert.ok(block.includes('className="h-7 gap-1 text-xs"'), 'must match the neighbouring buttons’ className exactly');
    assert.ok(
      block.includes('disabled={!searchFilterResult || searchFilterResult.rows.length === 0}'),
      'must use the identical disabled-guard as Create list / Export',
    );
    assert.ok(block.includes('title='), 'must carry a title tooltip');
  });

  test('calls collectFilterResultGlobalIds, clears, isolates, selects, frames, and closes the modal', () => {
    const body = handleIsolateResultBody();
    for (const call of [
      'collectFilterResultGlobalIds(',
      'setSelectedEntityIds([])',
      'isolateEntities(globalIds)',
      'setSelectedEntityIds(globalIds)',
      'cameraCallbacks.frameSelection',
      'setSearchModalOpen(false)',
    ]) {
      assert.ok(body.includes(call), `handleIsolateResult must call ${call}`);
    }
  });

  test('clears the multi-selection BEFORE isolating/selecting, since clearing resets selectedEntityId', () => {
    const body = handleIsolateResultBody();
    const cleared = body.indexOf('setSelectedEntityIds([])');
    const isolated = body.indexOf('isolateEntities(globalIds)');
    const selected = body.indexOf('setSelectedEntityIds(globalIds)');
    assert.ok(cleared >= 0 && isolated >= 0 && selected >= 0, 'all three calls must be present');
    assert.ok(
      cleared < selected,
      'setSelectedEntityIds([]) must run BEFORE setSelectedEntityIds(globalIds) — clearing also resets ' +
        'selectedEntityId, so the reverse order discards the selection frameSelection needs',
    );
    assert.ok(
      isolated < selected,
      'isolateEntities must run before the isolated set is selected for framing (select the RESULT of isolation)',
    );
  });

  test('requests the frame and closes the modal only after the isolated set is selected', () => {
    const body = handleIsolateResultBody();
    const selected = body.indexOf('setSelectedEntityIds(globalIds)');
    const frame = body.indexOf('cameraCallbacks.frameSelection');
    assert.ok(selected >= 0 && frame >= 0, 'both calls must be present');
    assert.ok(selected < frame, 'the isolated set must be selected before requesting the frame');
  });

  test('closes the modal only after requesting the frame', () => {
    const body = handleIsolateResultBody();
    const frame = body.indexOf('cameraCallbacks.frameSelection');
    const close = body.indexOf('setSearchModalOpen(false)');
    assert.ok(frame >= 0 && close >= 0, 'both calls must be present');
    assert.ok(close > frame, 'the frame must be requested before the modal closes');
  });

  test('bails out before touching any selection/visibility state when the result is empty', () => {
    const body = handleIsolateResultBody();
    const guardIdx = body.indexOf('if (!result || result.rows.length === 0) return;');
    const idsGuardIdx = body.indexOf('if (globalIds.length === 0) return;');
    const clearIdx = body.indexOf('setSelectedEntityIds([])');
    assert.ok(guardIdx >= 0, 'must guard on an empty/missing result before doing anything else');
    assert.ok(idsGuardIdx >= 0, 'must guard on an empty resolved id list (e.g. all rows unresolved)');
    assert.ok(
      guardIdx < clearIdx && idsGuardIdx < clearIdx,
      'both empty guards must run BEFORE any store mutation — an empty/no-op run must never touch visibility',
    );
  });

  test('the handler declares every store setter it calls as a dependency', () => {
    const start = source.indexOf('const handleIsolateResult = useCallback(');
    const depsStart = source.indexOf('}, [', start);
    const depsEnd = source.indexOf(']);', depsStart);
    const deps = source.slice(depsStart, depsEnd);
    for (const dep of ['setSearchModalOpen', 'setSelectedEntityIds', 'isolateEntities', 'cameraCallbacks', 'models', 'activeModelId']) {
      assert.ok(deps.includes(dep), `${dep} must be in the useCallback dependency array`);
    }
  });

  test('running the filter never touches isolation/selection — isolate is opt-in via the button only', () => {
    const start = source.indexOf('const runFilter = useCallback(');
    assert.notEqual(start, -1, 'runFilter must exist in SearchModal.filter.tsx');
    const end = source.indexOf('}, [', start);
    assert.notEqual(end, -1, 'runFilter must end with a dependency array');
    const body = source.slice(start, end);
    assert.ok(
      !body.includes('isolateEntities(') && !body.includes('setSelectedEntityIds('),
      'runFilter (the Run button) must never call isolateEntities or setSelectedEntityIds — ' +
        'isolation is opt-in, only handleIsolateResult may touch that state',
    );
  });

  test('the component binds isolateEntities from the store (the same channel HierarchyPanel isolation uses)', () => {
    assert.ok(
      source.includes('isolateEntities: s.isolateEntities'),
      'isolateEntities must be pulled from the store selector, or the handler would reference an undefined binding',
    );
    // Guard against inventing a parallel isolation mechanism (e.g. the
    // basket-based executeBasketIsolate used by MainToolbar/CommandPalette).
    assert.ok(
      !source.includes('executeBasketIsolate'),
      'must reuse HierarchyPanel’s isolateEntities channel, not the basket-isolate mechanism',
    );
  });
});
