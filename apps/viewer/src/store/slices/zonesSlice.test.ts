/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `editingZone` dangling-reference invariant (CodeRabbit review of PR #1869):
 * every action that can remove the zone an edit session points at must clear
 * (or re-validate) `editingZone` — `removeZoneSet`/`removeZone` always did,
 * but `replaceZonesInSet` ("generate from storeys") and `importZoneSetsJSON`
 * (replaces every set) left it dangling on a zone that no longer exists.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createZonesSlice, type ZonesSlice } from './zonesSlice.js';
import type { Zone, ZoneSet } from '../../lib/zones/types.js';

function makeZone(id: string, name = id): Zone {
  return { id, name, center: [0, 0, 0], size: [5, 3, 5], rotationY: 0 };
}

function makeSet(id: string, zones: Zone[], name = id): ZoneSet {
  return { id, name, zones, visible: true, createdAt: 1, updatedAt: 1 };
}

function importFileJSON(zoneSets: ZoneSet[]): string {
  return JSON.stringify({ version: 1, exportedAt: new Date(0).toISOString(), zoneSets });
}

describe('ZonesSlice editingZone lifecycle', () => {
  let state: ZonesSlice;

  beforeEach(() => {
    const setState = (
      partial: Partial<ZonesSlice> | ((s: ZonesSlice) => Partial<ZonesSlice>),
    ): void => {
      const updates = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...updates };
    };
    const getState = (): ZonesSlice => state;
    state = createZonesSlice(setState as never, getState as never, {} as never);
    // Seed one set with two zones and start an edit session on zone "a".
    state = { ...state, zoneSets: [makeSet('set-1', [makeZone('a'), makeZone('b')])] };
    state.setEditingZone({ setId: 'set-1', zoneId: 'a' });
  });

  describe('replaceZonesInSet', () => {
    it('clears editingZone when the edited zone is not among the replacement zones', () => {
      state.replaceZonesInSet('set-1', [makeZone('storey-0'), makeZone('storey-1')]);
      assert.strictEqual(state.editingZone, null);
    });

    it('keeps editingZone when the replacement zones still contain the edited zone id', () => {
      state.replaceZonesInSet('set-1', [makeZone('a'), makeZone('c')]);
      assert.deepStrictEqual(state.editingZone, { setId: 'set-1', zoneId: 'a' });
    });

    it('keeps an edit session in an UNRELATED set untouched', () => {
      state = { ...state, zoneSets: [...state.zoneSets, makeSet('set-2', [makeZone('x')])] };
      state.setEditingZone({ setId: 'set-2', zoneId: 'x' });
      state.replaceZonesInSet('set-1', []);
      assert.deepStrictEqual(state.editingZone, { setId: 'set-2', zoneId: 'x' });
    });
  });

  describe('importZoneSetsJSON', () => {
    it('clears editingZone when the imported data no longer contains the edited set', () => {
      const result = state.importZoneSetsJSON(importFileJSON([makeSet('other-set', [makeZone('z')])]));
      assert.deepStrictEqual(result, { ok: true });
      assert.strictEqual(state.editingZone, null);
    });

    it('clears editingZone when the set survives but the edited zone id does not', () => {
      const result = state.importZoneSetsJSON(importFileJSON([makeSet('set-1', [makeZone('b')])]));
      assert.deepStrictEqual(result, { ok: true });
      assert.strictEqual(state.editingZone, null);
    });

    it('keeps editingZone when the imported data still contains the exact set + zone', () => {
      const result = state.importZoneSetsJSON(importFileJSON([makeSet('set-1', [makeZone('a')])]));
      assert.deepStrictEqual(result, { ok: true });
      assert.deepStrictEqual(state.editingZone, { setId: 'set-1', zoneId: 'a' });
    });

    it('leaves editingZone alone when the import is rejected', () => {
      const result = state.importZoneSetsJSON('{"version": 99}');
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(state.editingZone, { setId: 'set-1', zoneId: 'a' });
    });
  });
});
