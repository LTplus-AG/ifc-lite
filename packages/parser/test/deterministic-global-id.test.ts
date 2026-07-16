/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { deterministicGlobalId } from '../src/deterministic-global-id.js';
import { ifcGuidToUuid, isValidIfcGuid, isValidUuid } from '@ifc-lite/encoding';

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
});
