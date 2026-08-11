/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source-level wiring tests for the Search tab's row-click / Enter `commit`
 * handler in `SearchModal.text.tsx`.
 *
 * `SearchModalText` reads the store directly via `useViewerStore` and
 * renders a virtualized list, so it cannot be mounted under `tsx --test`,
 * and this repo rejects `mock.module` (see
 * `apps/viewer/src/sdk/ExtensionHostProvider.tsx:27-30`).
 * `frameSelection` (Viewport.tsx) PREFERS the numeric multi-selection set
 * over the single selection, so a stale box/basket selection made `commit`
 * frame the OLD elements instead of the search result the user just
 * clicked/entered. `HierarchyPanel` already guards this with
 * `setSelectedEntityIds([])` before selecting; `commit` must do the same.
 *
 * The ordering assertion is load-bearing: `setSelectedEntityIds([])` also
 * resets `selectedEntityId` (selectionSlice.ts), so clearing AFTER
 * selecting would silently discard the selection and frame nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'SearchModal.text.tsx'), 'utf8');

/**
 * Strip `//` line comments. Without this these tests are VACUOUS: the
 * handler's own comment quotes the very calls being asserted (e.g.
 * "`setSelectedEntityIds([])` resets `selectedEntityId`"), so a naive
 * `indexOf` matches the comment rather than the statement — and since the
 * comment sits above both calls, the ordering assertion passes no matter
 * how the real statements are ordered. This exact failure mode shipped
 * once already (PR #2396) before comment-stripping was added there.
 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** The body of `commit`, from its declaration to the dependency array. */
function commitBody(): string {
  const start = source.indexOf('const commit = useCallback(');
  assert.notEqual(start, -1, 'commit must exist in SearchModal.text.tsx');
  const end = source.indexOf('    [\n', start);
  assert.notEqual(end, -1, 'commit must end with a dependency array');
  const body = stripLineComments(source.slice(start, end));
  // Guard the guard: if the stripping ever removes the statements
  // themselves, every assertion below would fail loudly rather than
  // silently pass.
  assert.ok(body.includes('setSelectedEntityId('), 'stripped body must retain the selection calls');
  return body;
}

describe('SearchModalText: commit wiring', () => {
  test('clears the multi-selection, selects, frames, enters vim cycle, and closes', () => {
    const body = commitBody();
    for (const call of [
      'setSelectedEntityIds([])',
      'setSelectedEntityId(globalId)',
      'setSelectedEntity(ref)',
      'cameraCallbacks.frameSelection',
      'enterVimCycle(',
      'onClose()',
    ]) {
      assert.ok(body.includes(call), `commit must call ${call}`);
    }
  });

  test('clears the multi-selection BEFORE selecting, since clearing resets selectedEntityId', () => {
    const body = commitBody();
    const cleared = body.indexOf('setSelectedEntityIds([])');
    const selected = body.indexOf('setSelectedEntityId(globalId)');
    assert.ok(cleared >= 0 && selected >= 0, 'both calls must be present');
    assert.ok(
      cleared < selected,
      'setSelectedEntityIds([]) must run BEFORE setSelectedEntityId — clearing also resets selectedEntityId, so the reverse order discards the selection and frames nothing',
    );
  });

  test('clears the multi-selection BEFORE entering the vim cycle', () => {
    const body = commitBody();
    const cleared = body.indexOf('setSelectedEntityIds([])');
    const cycle = body.indexOf('enterVimCycle(');
    assert.ok(cleared >= 0 && cycle >= 0, 'both calls must be present');
    assert.ok(cleared < cycle, 'setSelectedEntityIds([]) must run before enterVimCycle');
  });

  test('the handler declares every store setter it calls as a dependency', () => {
    const start = source.indexOf('const commit = useCallback(');
    const depsStart = source.indexOf('    [\n', start);
    const depsEnd = source.indexOf('  );', depsStart);
    const deps = source.slice(depsStart, depsEnd);
    for (const dep of ['setSelectedEntityIds', 'setSelectedEntityId', 'setSelectedEntity', 'enterVimCycle', 'onClose']) {
      assert.ok(deps.includes(dep), `${dep} must be in the useCallback dependency array`);
    }
  });

  test('the component binds setSelectedEntityIds from the store', () => {
    assert.ok(
      source.includes('setSelectedEntityIds: s.setSelectedEntityIds'),
      'setSelectedEntityIds must be pulled from the store selector, or commit would reference an undefined binding',
    );
  });

  test('the additive (Shift+Enter) toggleAdditive path does NOT clear the multi-selection', () => {
    const start = source.indexOf('const toggleAdditive = useCallback(');
    assert.notEqual(start, -1, 'toggleAdditive must exist');
    const end = source.indexOf('  );', start);
    const body = stripLineComments(source.slice(start, end));
    assert.ok(body.includes('toggleEntitySelection('), 'toggleAdditive must still toggle into the multi-selection');
    assert.ok(
      !body.includes('setSelectedEntityIds([])'),
      'toggleAdditive must NOT clear the multi-selection — Shift+Enter is meant to build it up',
    );
  });
});
