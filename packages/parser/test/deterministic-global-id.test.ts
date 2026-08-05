/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { deterministicGlobalId } from '../src/deterministic-global-id.js';
import { ifcGuidToUuid, uuidToIfcGuid, isValidIfcGuid, isValidUuid } from '@ifc-lite/encoding';

/** The first GlobalId character encodes only 2 bits, so it must be one of the
 *  first four alphabet chars. */
const VALID_FIRST_CHARS = new Set(['0', '1', '2', '3']);

describe('deterministicGlobalId', () => {
  const seeds = [
    'task-0',
    'work-schedule-1',
    'sequence-42',
    '314.5',
    'IfcBuildingStorey/Level 3',
    '',
    'x',
    'a'.repeat(200),
  ];

  it('always produces a 22-char id whose first char is in the valid 2-bit set', () => {
    for (const seed of seeds) {
      const id = deterministicGlobalId(seed);
      expect(id).toHaveLength(22);
      expect(VALID_FIRST_CHARS.has(id[0])).toBe(true);
    }
  });

  it('decodes to a valid 128-bit UUID via the canonical compressor', () => {
    for (const seed of seeds) {
      const id = deterministicGlobalId(seed);
      // A first char in the full 6-bit range would decode to a >128-bit value;
      // the canonical validator rejects that.
      expect(isValidIfcGuid(id)).toBe(true);
      const uuid = ifcGuidToUuid(id);
      expect(isValidUuid(uuid)).toBe(true);
    }
  });

  it('adversarial first-char coverage: 256 single-char deltas all decode cleanly', () => {
    for (let i = 0; i < 256; i++) {
      const id = deterministicGlobalId(`storey-${String.fromCharCode(i)}`);
      expect(VALID_FIRST_CHARS.has(id[0])).toBe(true);
      expect(() => ifcGuidToUuid(id)).not.toThrow();
    }
  });

  it('is deterministic across calls for the same seed', () => {
    expect(deterministicGlobalId('task-0')).toBe(deterministicGlobalId('task-0'));
  });

  it('pins exact output for known seeds (golden values)', () => {
    // Every other test here only checks shape (length, valid-GUID, no
    // collisions, self-consistency) — none of them fix what the hash
    // actually IS. That means the four-stream mix (h0..h3 -> m0..m3) can
    // have its cross-mixing swapped or reordered (e.g. m2/m3 computed from
    // the wrong pair of inputs) and every existing test still passes,
    // because a differently-wrong-but-still-valid-looking GUID satisfies
    // "22 chars", "valid GUID", "deterministic", and "no collisions" just
    // as well as the correct one. Pin concrete outputs to catch that.
    //
    // These are a stability contract, not a check against an external spec:
    // GlobalIds are written into exported IFC files and persist, so changing
    // the mix silently re-identifies every entity. If the hash is ever
    // changed deliberately, update these values and say so in the changeset.
    expect(deterministicGlobalId('task-0')).toBe('2i3WPHzRz3kT_LFizulWG$');
    expect(deterministicGlobalId('')).toBe('1IjrY9muLCZQE2I7v1L6Fe');
    expect(deterministicGlobalId('IfcBuildingStorey/Level 3')).toBe('2QDAlbpFkPRGtzHiOREUww');
  });

  it('decode/re-encode round-trips bit-exactly for 10,000 seeds (full 128-bit fidelity)', () => {
    // A GUID whose first char used the full 6-bit alphabet decodes to >128 bits
    // and cannot survive uuid -> guid re-encoding. Round-tripping through the
    // canonical compressor proves every emitted char carries only valid bits.
    for (let i = 0; i < 10_000; i++) {
      const id = deterministicGlobalId(`seed-${i}`);
      expect(uuidToIfcGuid(ifcGuidToUuid(id))).toBe(id);
    }
  });

  it('produces no collisions across 10,000 sequential seeds', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(deterministicGlobalId(`entity/${i}`));
    }
    expect(seen.size).toBe(10_000);
  });
});
