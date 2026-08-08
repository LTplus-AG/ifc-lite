/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source-level wiring tests for `SearchInline`'s `applySelection` — the
 * shared select+frame helper used by both Enter-commit and n/N vim-cycle
 * stepping.
 *
 * `SearchInline` reads the store directly via `useViewerStore`, so it
 * cannot be mounted under `tsx --test`, and this repo rejects
 * `mock.module` (see `apps/viewer/src/sdk/ExtensionHostProvider.tsx:27-30`).
 * `frameSelection` (Viewport.tsx) PREFERS the numeric multi-selection set
 * over the single selection, so a stale box/basket selection made the
 * camera frame the OLD elements instead of a freshly-picked search result.
 * `HierarchyPanel` already guards this with `setSelectedEntityIds([])`
 * before selecting; `applySelection`'s non-additive branch must do the
 * same. Only a test that pins the call sequence catches a regression here.
 *
 * The ordering assertion is load-bearing: `setSelectedEntityIds([])` also
 * resets `selectedEntityId` (selectionSlice.ts), so clearing AFTER
 * selecting would silently discard the selection and frame nothing.
 *
 * The additive (Shift+Enter) branch is deliberately NOT touched: it is
 * meant to build up the multi-selection across successive picks, so
 * clearing there would defeat its purpose.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'SearchInline.tsx'), 'utf8');

/**
 * Strip `//` line comments. Without this these tests are VACUOUS: the
 * function's own comment quotes the very calls being asserted (e.g.
 * "`setSelectedEntityIds([])` resets `selectedEntityId`"), so a naive
 * `indexOf` matches the comment rather than the statement — and since the
 * comment sits above both calls, the ordering assertion passes no matter
 * how the real statements are ordered.
 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** The body of `applySelection`, from its declaration to the dependency array. */
function applySelectionBody(): string {
  const start = source.indexOf('const applySelection = useCallback(');
  assert.notEqual(start, -1, 'applySelection must exist in SearchInline.tsx');
  const end = source.indexOf('    [\n', start);
  assert.notEqual(end, -1, 'applySelection must end with a dependency array');
  const body = stripLineComments(source.slice(start, end));
  // Guard the guard: if the stripping ever removes the statements
  // themselves, every assertion below would fail loudly rather than
  // silently pass.
  assert.ok(body.includes('setSelectedEntityId('), 'stripped body must retain the selection calls');
  return body;
}

/** The non-additive tail of applySelection, i.e. after the `addToSelection` early return. */
function nonAdditiveBody(): string {
  const body = applySelectionBody();
  const returnIdx = body.indexOf('return;');
  assert.notEqual(returnIdx, -1, 'applySelection must have the additive early-return branch');
  return body.slice(returnIdx + 'return;'.length);
}

describe('SearchInline: applySelection non-additive wiring', () => {
  test('clears the multi-selection before selecting and framing', () => {
    const body = nonAdditiveBody();
    for (const call of [
      'setSelectedEntityIds([])',
      'setSelectedEntityId(globalId)',
      'setSelectedEntity(ref)',
      'cameraCallbacks.frameSelection',
    ]) {
      assert.ok(body.includes(call), `applySelection (non-additive) must call ${call}`);
    }
  });

  test('clears the multi-selection BEFORE selecting, since clearing resets selectedEntityId', () => {
    const body = nonAdditiveBody();
    const cleared = body.indexOf('setSelectedEntityIds([])');
    const selected = body.indexOf('setSelectedEntityId(globalId)');
    assert.ok(cleared >= 0 && selected >= 0, 'both calls must be present');
    assert.ok(
      cleared < selected,
      'setSelectedEntityIds([]) must run BEFORE setSelectedEntityId — clearing also resets selectedEntityId, so the reverse order discards the selection and frames nothing',
    );
  });

  test('the additive (Shift+Enter) branch does NOT clear the multi-selection', () => {
    const body = applySelectionBody();
    const returnIdx = body.indexOf('return;');
    const additiveBody = body.slice(0, returnIdx);
    assert.ok(
      additiveBody.includes('toggleEntitySelection('),
      'the additive branch must still toggle into the multi-selection',
    );
    assert.ok(
      !additiveBody.includes('setSelectedEntityIds([])'),
      'the additive branch must NOT clear the multi-selection — Shift+Enter is meant to build it up',
    );
  });

  test('applySelection declares every store setter it calls as a dependency', () => {
    const start = source.indexOf('const applySelection = useCallback(');
    const depsStart = source.indexOf('    [\n', start);
    const depsEnd = source.indexOf('  );', depsStart);
    const deps = source.slice(depsStart, depsEnd);
    for (const dep of ['setSelectedEntityIds', 'setSelectedEntityId', 'setSelectedEntity', 'toggleEntitySelection']) {
      assert.ok(deps.includes(dep), `${dep} must be in the useCallback dependency array`);
    }
  });

  test('the component binds setSelectedEntityIds from the store', () => {
    assert.ok(
      source.includes('setSelectedEntityIds: s.setSelectedEntityIds'),
      'setSelectedEntityIds must be pulled from the store selector, or applySelection would reference an undefined binding',
    );
  });

  test('n/N vim-cycle stepping reuses applySelection (so the fix also covers it)', () => {
    const cycleEffectStart = source.indexOf('const isEntry = !last || last.results !== searchVimCycle.results;');
    assert.notEqual(cycleEffectStart, -1, 'the vim-cycle-step effect must exist');
    const tail = source.slice(cycleEffectStart, cycleEffectStart + 400);
    assert.ok(
      tail.includes('applySelection(current, false)'),
      'the vim-cycle-step effect must call applySelection(current, false) — the same non-additive path that clears the stale multi-selection',
    );
  });
});
