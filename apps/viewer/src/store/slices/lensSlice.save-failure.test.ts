/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens persistence must not lie: when the localStorage write fails, the CRUD
 * action reports it instead of committing an edit that is gone on reload.
 * Mirrors the clash preset CRUD contract (`SaveResult`, commit only on ok).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Lens } from '@ifc-lite/lens';
import { createLensSlice, type LensSlice } from './lensSlice.js';

/**
 * In-memory localStorage stub. Reads always work — only writes can be made to
 * fail, so the slice still loads its saved set and the failure under test is
 * genuinely the write (a stub that rejected reads too would pass vacuously
 * against a slice that never saw any storage at all).
 */
function installStubStorage(failWrites: boolean): Map<string, string> {
  const data = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new DOMException('quota', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
  } as Storage;
  return data;
}

const LENS: Lens = {
  id: 'lens-test-1',
  name: 'Test lens',
  rules: [{ id: 'r1', name: 'walls', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#ff0000' }],
};

function makeSlice(): { get: () => LensSlice } {
  let state: LensSlice;
  const set = (partial: unknown) => {
    const next = typeof partial === 'function'
      ? (partial as (s: LensSlice) => Partial<LensSlice>)(state)
      : partial as Partial<LensSlice>;
    state = { ...state, ...next };
  };
  state = createLensSlice(set as never, () => state, {} as never);
  return { get: () => state };
}

describe('lensSlice persistence failures', () => {
  describe('when the storage write fails', () => {
    beforeEach(() => { installStubStorage(true); });

    it('createLens reports the failure and does not commit the lens', () => {
      const slice = makeSlice();
      const before = slice.get().savedLenses.length;
      const result = slice.get().createLens(LENS);
      // State first: this is the defect. The old slice committed the lens to
      // the store and returned nothing, so the panel showed a lens that was
      // gone on reload.
      assert.equal(slice.get().savedLenses.length, before,
        'a lens that could not be persisted must not appear as saved');
      assert.equal(result.ok, false, 'createLens must report the write failure');
      assert.ok(!result.ok && result.message.length > 0, 'failure must carry a user-facing message');
    });

    it('updateLens reports the failure and does not commit the rename', () => {
      const slice = makeSlice();
      const target = slice.get().savedLenses[0];
      const result = slice.get().updateLens(target.id, { name: 'Renamed' });
      assert.equal(slice.get().savedLenses[0].name, target.name,
        'a rename that could not be persisted must not appear applied');
      assert.equal(result.ok, false);
    });

    it('deleteLens reports the failure and keeps the lens', () => {
      // Seed a deletable (non-builtin) lens with writes temporarily working,
      // then break writes: only the delete's persistence is under test.
      installStubStorage(false);
      const slice = makeSlice();
      assert.equal(slice.get().createLens(LENS).ok, true);
      const count = slice.get().savedLenses.length;
      installStubStorage(true);
      const result = slice.get().deleteLens(LENS.id);
      assert.equal(slice.get().savedLenses.length, count,
        'a delete that could not be persisted must not appear applied');
      assert.ok(slice.get().savedLenses.some((l) => l.id === LENS.id));
      assert.equal(result.ok, false);
    });

    it('duplicateLens reports the failure and does not commit the copy', () => {
      const slice = makeSlice();
      const source = slice.get().savedLenses[0];
      const before = slice.get().savedLenses.length;
      const result = slice.get().duplicateLens(source.id);
      assert.equal(slice.get().savedLenses.length, before,
        'a copy that could not be persisted must not appear as saved');
      assert.equal(result.ok, false);
    });

    it('importLenses reports the failure and does not commit the imports', () => {
      const slice = makeSlice();
      const before = slice.get().savedLenses.length;
      const result = slice.get().importLenses([LENS]);
      assert.equal(slice.get().savedLenses.length, before,
        'imports that could not be persisted must not appear as saved');
      assert.equal(result.ok, false);
    });

    it('setSavedLenses reports the failure and does not commit the snapshot', () => {
      const slice = makeSlice();
      const before = slice.get().savedLenses.length;
      const result = slice.get().setSavedLenses([LENS]);
      assert.equal(slice.get().savedLenses.length, before,
        'a snapshot that could not be persisted must not appear applied');
      assert.equal(result.ok, false);
    });
  });

  // Negative cases: the happy path must keep working, silently and completely.
  describe('when the storage write succeeds', () => {
    let data: Map<string, string>;
    beforeEach(() => { data = installStubStorage(false); });

    it('createLens commits, reports ok and actually persists', () => {
      const slice = makeSlice();
      const result = slice.get().createLens(LENS);
      assert.equal(result.ok, true, 'a successful save must not report an error');
      assert.ok(slice.get().savedLenses.some((l) => l.id === LENS.id));
      const raw = data.get('ifc-lite-custom-lenses');
      assert.ok(raw && raw.includes(LENS.id), 'the lens must reach localStorage');
    });

    it('updateLens commits the rename', () => {
      const slice = makeSlice();
      assert.equal(slice.get().createLens(LENS).ok, true);
      const result = slice.get().updateLens(LENS.id, { name: 'Renamed' });
      assert.equal(result.ok, true);
      assert.equal(slice.get().savedLenses.find((l) => l.id === LENS.id)?.name, 'Renamed');
    });

    it('deleteLens still deletes', () => {
      const slice = makeSlice();
      assert.equal(slice.get().createLens(LENS).ok, true);
      const result = slice.get().deleteLens(LENS.id);
      assert.equal(result.ok, true);
      assert.ok(!slice.get().savedLenses.some((l) => l.id === LENS.id),
        'an intentional delete must still remove the lens');
      const raw = data.get('ifc-lite-custom-lenses');
      assert.ok(!raw?.includes(LENS.id), 'the delete must reach localStorage');
    });

    it('deleting a builtin is still a no-op, reported as ok', () => {
      const slice = makeSlice();
      const builtin = slice.get().savedLenses.find((l) => l.builtin);
      assert.ok(builtin, 'expected builtin lenses in the initial set');
      const count = slice.get().savedLenses.length;
      assert.equal(slice.get().deleteLens(builtin.id).ok, true);
      assert.equal(slice.get().savedLenses.length, count);
    });

    it('duplicateLens commits the copy and returns it', () => {
      const slice = makeSlice();
      const source = slice.get().savedLenses[0];
      const before = slice.get().savedLenses.length;
      const result = slice.get().duplicateLens(source.id);
      assert.equal(result.ok, true);
      assert.ok(result.ok && result.lens && result.lens.id !== source.id);
      assert.equal(slice.get().savedLenses.length, before + 1);
    });

    it('duplicateLens on a missing id is a no-op, reported as ok with no lens', () => {
      const slice = makeSlice();
      const before = slice.get().savedLenses.length;
      const result = slice.get().duplicateLens('no-such-lens');
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.lens, null);
      assert.equal(slice.get().savedLenses.length, before);
    });
  });
});
