/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source-level wiring tests for the advanced Filter tab's row-click handler.
 *
 * `SearchModalFilter` reads the store directly and renders a virtualized
 * table, so it cannot be mounted under `tsx --test`, and this repo rejects
 * `mock.module` (see `apps/viewer/src/sdk/ExtensionHostProvider.tsx:27-30`).
 * What actually broke here was not logic but WIRING — the handler selected
 * and framed but never cleared the stale multi-selection and never closed the
 * modal, so the camera flew to the element behind a full-screen `bg-black/80`
 * scrim and the click read as doing nothing. Only a test that pins the call
 * sequence catches that class of regression.
 *
 * The ordering assertion is the load-bearing one: `setSelectedEntityIds([])`
 * also resets `selectedEntityId` (HierarchyPanel.tsx:410-411), so clearing
 * AFTER selecting would silently throw the selection away and frame nothing.
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

/** The body of `handleRowClick`, from its declaration to the dependency array. */
function handleRowClickBody(): string {
  const start = source.indexOf('const handleRowClick = useCallback(');
  assert.notEqual(start, -1, 'handleRowClick must exist in SearchModal.filter.tsx');
  const end = source.indexOf('}, [', start);
  assert.notEqual(end, -1, 'handleRowClick must end with a dependency array');
  const body = stripLineComments(source.slice(start, end));
  // Guard the guard: if the stripping ever removes the statements themselves,
  // every assertion below would fail loudly rather than silently pass.
  assert.ok(body.includes('setSelectedEntityId('), 'stripped body must retain the selection calls');
  return body;
}

describe('advanced Filter tab: row-click wiring', () => {
  test('clears the multi-selection, selects, frames, and closes the modal', () => {
    const body = handleRowClickBody();
    for (const call of [
      'setSelectedEntityIds([])',
      'setSelectedEntityId(globalId)',
      'setSelectedEntity({',
      'cameraCallbacks.frameSelection',
      'setSearchModalOpen(false)',
    ]) {
      assert.ok(body.includes(call), `handleRowClick must call ${call}`);
    }
  });

  test('clears the multi-selection BEFORE selecting, since clearing resets selectedEntityId', () => {
    const body = handleRowClickBody();
    const cleared = body.indexOf('setSelectedEntityIds([])');
    const selected = body.indexOf('setSelectedEntityId(globalId)');
    assert.ok(cleared >= 0 && selected >= 0, 'both calls must be present');
    assert.ok(
      cleared < selected,
      'setSelectedEntityIds([]) must run BEFORE setSelectedEntityId — clearing also resets selectedEntityId, so the reverse order discards the selection and frames nothing',
    );
  });

  test('closes the modal only after requesting the frame', () => {
    const body = handleRowClickBody();
    const frame = body.indexOf('cameraCallbacks.frameSelection');
    const close = body.indexOf('setSearchModalOpen(false)');
    assert.ok(frame >= 0 && close >= 0, 'both calls must be present');
    assert.ok(close > frame, 'the frame must be requested before the modal closes');
  });

  test('the handler declares every store setter it calls as a dependency', () => {
    const start = source.indexOf('const handleRowClick = useCallback(');
    const depsStart = source.indexOf('}, [', start);
    const depsEnd = source.indexOf(']);', depsStart);
    const deps = source.slice(depsStart, depsEnd);
    for (const dep of ['setSearchModalOpen', 'setSelectedEntityIds', 'setSelectedEntityId']) {
      assert.ok(deps.includes(dep), `${dep} must be in the useCallback dependency array`);
    }
  });

  test('the component binds setSelectedEntityIds from the store', () => {
    assert.ok(
      source.includes('setSelectedEntityIds: s.setSelectedEntityIds'),
      'setSelectedEntityIds must be pulled from the store selector, or the handler would reference an undefined binding',
    );
  });
});
