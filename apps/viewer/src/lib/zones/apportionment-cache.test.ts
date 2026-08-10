/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  coverageOf,
  validEntry,
  volumeGateVerdict,
  zoneSetRevision,
  PROVED_VOLUME_AGREEMENT_REL,
  type ZoneApportionmentEntry,
} from './apportionment-cache.js';
import type { Zone, ZoneSet } from './types.js';

function zone(overrides: Partial<Zone> & Pick<Zone, 'id'>): Zone {
  return { name: overrides.id, center: [0, 0, 0], size: [4, 4, 4], rotationY: 0, ...overrides };
}

function zoneSet(zones: Zone[], overrides: Partial<ZoneSet> = {}): ZoneSet {
  return { id: 'zs', name: 'Takt', visible: true, createdAt: 0, updatedAt: 0, zones, ...overrides };
}

function entry(revision: string, overrides: Partial<ZoneApportionmentEntry> = {}): ZoneApportionmentEntry {
  return {
    revision,
    byElement: new Map(),
    refused: new Map(),
    computedAt: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe('zones/apportionment-cache', () => {
  describe('the revision that decides whether cached cubic metres are still true', () => {
    const base = zoneSet([zone({ id: 'a', center: [1, 2, 3] }), zone({ id: 'b' })]);

    it('moving a zone changes it', () => {
      const moved = zoneSet([zone({ id: 'a', center: [1, 2, 3.5] }), zone({ id: 'b' })]);
      assert.notStrictEqual(zoneSetRevision(moved), zoneSetRevision(base));
    });

    it('resizing a zone changes it', () => {
      const resized = zoneSet([zone({ id: 'a', center: [1, 2, 3], size: [4, 4, 5] }), zone({ id: 'b' })]);
      assert.notStrictEqual(zoneSetRevision(resized), zoneSetRevision(base));
    });

    it('rotating a zone changes it', () => {
      const rotated = zoneSet([zone({ id: 'a', center: [1, 2, 3], rotationY: 0.1 }), zone({ id: 'b' })]);
      assert.notStrictEqual(zoneSetRevision(rotated), zoneSetRevision(base));
    });

    it('adding, removing or REORDERING zones changes it', () => {
      assert.notStrictEqual(zoneSetRevision(zoneSet([zone({ id: 'a', center: [1, 2, 3] })])), zoneSetRevision(base));
      assert.notStrictEqual(
        zoneSetRevision(zoneSet([zone({ id: 'b' }), zone({ id: 'a', center: [1, 2, 3] })])),
        zoneSetRevision(base),
        'shares are reported in zone-set order, so order is part of the answer',
      );
    });

    it('renaming a zone changes it — the name is printed next to the value', () => {
      const renamed = zoneSet([zone({ id: 'a', name: 'Area 1', center: [1, 2, 3] }), zone({ id: 'b' })]);
      assert.notStrictEqual(zoneSetRevision(renamed), zoneSetRevision(base));
    });

    it('but renaming the SET, or hiding it, does not', () => {
      // Neither moves a cubic metre, and throwing away a whole model's clip
      // results for a rename is the needless work this feature exists to avoid.
      assert.strictEqual(zoneSetRevision(zoneSet(base.zones, { name: 'Sections' })), zoneSetRevision(base));
      assert.strictEqual(zoneSetRevision(zoneSet(base.zones, { visible: false })), zoneSetRevision(base));
      assert.strictEqual(zoneSetRevision(zoneSet(base.zones, { updatedAt: 999 })), zoneSetRevision(base));
    });

    it('two zone lists cannot collide by field concatenation', () => {
      // A revision built by gluing fields together with a printable separator
      // can be forged: zone names are free text a user types. These two sets
      // are DIFFERENT (two zones vs one) and produce byte-identical strings
      // under a space-delimited encoding —
      //   "a b 0,0,0 1,1,1 0" + "c d 0,0,0 1,1,1 0"
      //   "a " + "b 0,0,0 1,1,1 0c d" + " 0,0,0 1,1,1 0"
      // — so a user who names a zone that way would be served another zone
      // set's cached cubic metres. Length-prefixing makes it impossible.
      const box = { center: [0, 0, 0] as [number, number, number], size: [1, 1, 1] as [number, number, number], rotationY: 0 };
      const two = zoneSet([
        { id: 'a', name: 'b', ...box },
        { id: 'c', name: 'd', ...box },
      ]);
      const one = zoneSet([{ id: 'a', name: 'b 0,0,0 1,1,1 0c d', ...box }]);
      assert.notStrictEqual(
        zoneSetRevision(two),
        zoneSetRevision(one),
        'a forged zone name must not impersonate a different zone list',
      );
    });
  });

  describe('reading the cache', () => {
    const set = zoneSet([zone({ id: 'a' })]);

    it('serves an entry computed against the CURRENT zones', () => {
      const cache = new Map([['zs', entry(zoneSetRevision(set))]]);
      assert.ok(validEntry(cache, set));
    });

    it('drops one computed before the zones moved', () => {
      const cache = new Map([['zs', entry('some older revision')]]);
      assert.strictEqual(validEntry(cache, set), null);
    });

    it('has nothing to serve for a set never computed', () => {
      assert.strictEqual(validEntry(new Map(), set), null);
    });
  });

  describe('what a total left out', () => {
    it('separates the two refusal reasons, because they are different problems', () => {
      const e = entry('r', {
        byElement: new Map([[1, {} as never], [2, {} as never]]),
        refused: new Map([[3, 'no-geometry' as const], [4, 'unproved-solid' as const], [5, 'unproved-solid' as const]]),
      });
      assert.deepStrictEqual(coverageOf(e), { apportioned: 2, noGeometry: 1, unprovedSolid: 2 });
    });

    it('reports zeros rather than throwing when nothing has been computed', () => {
      assert.deepStrictEqual(coverageOf(null), { apportioned: 0, noGeometry: 0, unprovedSolid: 0 });
    });
  });

  // ==========================================================================
  // The gate. This is the rule that decides whether ANY of these numbers may be
  // shown, and it is the one the first measurement run got wrong: an open
  // 12-triangle beam shell apportioned to -1.071 m3 against a whole of 0.954,
  // and 32-40% of meshed elements in real models cannot be proved solid.
  // ==========================================================================
  describe('the closure gate', () => {
    const solid = { wholeVolumeM3: 4.23, unreliable: false };

    it('passes an element the kernel proved, whose two producers agree', () => {
      assert.strictEqual(volumeGateVerdict(4.2300005, solid), 'ok');
    });

    it('refuses when the renderer has no triangles at all', () => {
      assert.strictEqual(volumeGateVerdict(4.23, null), 'no-geometry');
      assert.strictEqual(volumeGateVerdict(undefined, null), 'no-geometry', 'no geometry outranks no proof');
    });

    it('refuses when the mesher proved nothing — the 32-40% case', () => {
      assert.strictEqual(volumeGateVerdict(undefined, solid), 'unproved-solid');
      assert.strictEqual(volumeGateVerdict(Number.NaN, solid), 'unproved-solid');
    });

    it('refuses when the clip itself reported inconsistent winding', () => {
      assert.strictEqual(volumeGateVerdict(4.23, { wholeVolumeM3: 4.23, unreliable: true }), 'unproved-solid');
    });

    it('refuses when the two producers DISAGREE — a silently short mesh', () => {
      // The Scene can hand back fewer triangles than the kernel measured (a
      // colour-merged batch re-extracted per entity keeps only triangles whose
      // three vertices all belong to it). The volume then looks perfectly
      // well-formed and is simply wrong, which is the worst failure mode there
      // is, so agreement is checked rather than assumed.
      assert.strictEqual(volumeGateVerdict(4.23, { wholeVolumeM3: 3.9, unreliable: false }), 'unproved-solid');
      assert.strictEqual(volumeGateVerdict(3.9, solid, 0.0001), 'unproved-solid');
    });

    it('tolerates f32 noise, which is three orders of magnitude below the threshold', () => {
      const noisy = { wholeVolumeM3: 4.23 * (1 + 3.4e-6), unreliable: false };
      assert.strictEqual(volumeGateVerdict(4.23, noisy), 'ok');
      assert.ok(3.4e-6 < PROVED_VOLUME_AGREEMENT_REL / 100, 'the measured worst f32 leak must stay far inside the gate');
    });

    it('a zero-volume element does not divide by zero', () => {
      assert.strictEqual(volumeGateVerdict(0, { wholeVolumeM3: 0, unreliable: false }), 'ok');
    });
  });
});
