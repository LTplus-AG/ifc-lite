/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { serializeZoneSets, parseZoneSetFile } from './persistence.js';
import type { ZoneSet } from './types.js';

function makeZoneSet(): ZoneSet {
  return {
    id: 'set-1',
    name: 'Sections',
    visible: true,
    createdAt: 1000,
    updatedAt: 2000,
    zones: [
      {
        id: 'zone-1',
        name: 'Section A',
        center: [1, 2, 3],
        size: [4, 5, 6],
        rotationY: 0.5,
        color: [0.1, 0.2, 0.3],
      },
      {
        id: 'zone-2',
        name: 'Section B',
        center: [-1, 0, -3],
        size: [4, 5, 6],
        rotationY: -1.2,
      },
    ],
  };
}

describe('zones/persistence', () => {
  it('round-trips zone sets through serialize -> JSON.stringify -> parse', () => {
    const original = [makeZoneSet()];
    const file = serializeZoneSets(original);
    const json = JSON.parse(JSON.stringify(file));
    const result = parseZoneSetFile(json);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.zoneSets, original);
    }
  });

  it('stamps the current schema version', () => {
    const file = serializeZoneSets([makeZoneSet()]);
    assert.strictEqual(file.version, 1);
  });

  it('rejects a file with the wrong version', () => {
    const file = serializeZoneSets([makeZoneSet()]);
    const tampered = { ...file, version: 99 };
    const result = parseZoneSetFile(tampered);
    assert.strictEqual(result.ok, false);
  });

  it('rejects a non-object payload', () => {
    assert.strictEqual(parseZoneSetFile(null).ok, false);
    assert.strictEqual(parseZoneSetFile('nope').ok, false);
    assert.strictEqual(parseZoneSetFile(42).ok, false);
  });

  it('rejects a zone set with a malformed zone (missing size)', () => {
    const file = serializeZoneSets([makeZoneSet()]);
    const bad = {
      ...file,
      zoneSets: [{ ...file.zoneSets[0], zones: [{ id: 'z', name: 'bad', center: [0, 0, 0], rotationY: 0 }] }],
    };
    const result = parseZoneSetFile(bad);
    assert.strictEqual(result.ok, false);
  });

  it('rejects a zone with a negative size component', () => {
    const file = serializeZoneSets([makeZoneSet()]);
    const bad = {
      ...file,
      zoneSets: [
        {
          ...file.zoneSets[0],
          zones: [{ id: 'z', name: 'bad', center: [0, 0, 0], size: [-1, 1, 1], rotationY: 0 }],
        },
      ],
    };
    const result = parseZoneSetFile(bad);
    assert.strictEqual(result.ok, false);
  });

  it('rejects zoneSets that is not an array', () => {
    const file = serializeZoneSets([makeZoneSet()]);
    const bad = { ...file, zoneSets: 'nope' };
    const result = parseZoneSetFile(bad);
    assert.strictEqual(result.ok, false);
  });

  // PR #1869 review: object spreads left center/size/color aliased to live
  // Zustand state, so mutating the serialized result mutated the store
  // outside an action.
  it('serializeZoneSets deep-copies vector tuples so mutating the result cannot touch the input', () => {
    const original = [makeZoneSet()];
    const file = serializeZoneSets(original);
    file.zoneSets[0].zones[0].center[0] = 999;
    file.zoneSets[0].zones[0].size[1] = 999;
    file.zoneSets[0].zones[0].color![2] = 999;
    assert.deepStrictEqual(original[0].zones[0].center, [1, 2, 3]);
    assert.deepStrictEqual(original[0].zones[0].size, [4, 5, 6]);
    assert.deepStrictEqual(original[0].zones[0].color, [0.1, 0.2, 0.3]);
  });

  // PR #1869 review: duplicate ids in an imported file made id-addressed
  // store actions (removeZoneSet/renameZoneSet/updateZone/removeZone)
  // silently affect multiple entries.
  describe('duplicate-id rejection on import', () => {
    it('rejects duplicate zone-set ids', () => {
      const file = serializeZoneSets([makeZoneSet(), makeZoneSet()]); // both id 'set-1'
      const result = parseZoneSetFile(JSON.parse(JSON.stringify(file)));
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.match(result.error, /duplicate zone-set id/);
    });

    it('rejects duplicate zone ids within one set', () => {
      const set = makeZoneSet();
      set.zones[1].id = set.zones[0].id; // 'zone-1' twice in the same set
      const result = parseZoneSetFile(JSON.parse(JSON.stringify(serializeZoneSets([set]))));
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.match(result.error, /duplicate zone id/);
    });

    it('accepts the same zone id in two DIFFERENT sets (ids are per-set for zones)', () => {
      const a = makeZoneSet();
      const b = { ...makeZoneSet(), id: 'set-2' };
      // zone ids are identical across a and b — updateZone is scoped by
      // setId, so this is unambiguous and must import fine.
      const result = parseZoneSetFile(JSON.parse(JSON.stringify(serializeZoneSets([a, b]))));
      assert.strictEqual(result.ok, true);
    });
  });
});
