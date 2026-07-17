/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A multi-valued property surfaces candidate `values[]` (issue #1766), so an
 * IDS property facet passes when the constraint matches ANY candidate — not
 * just the primary display value. Server-parsed models now carry these arrays
 * on the wire, reaching the facet check via the same PropertySetInfo shape the
 * WASM path produces.
 */

import { describe, it, expect } from 'vitest';
import { checkPropertyFacet } from '../facets/property-facet.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import type { IDSPropertyFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

const facet = (val: string): IDSPropertyFacet => ({
  type: 'property',
  propertySet: sv('Pset_WallCommon'),
  baseName: sv('AcousticRating'),
  value: sv(val),
});

// Enumerated property: display "R1, R2", candidates ['R1','R2'].
const accessor = createMockAccessor([
  {
    expressId: 1,
    type: 'IfcWall',
    properties: [
      { psetName: 'Pset_WallCommon', propName: 'AcousticRating', value: 'R1, R2', values: ['R1', 'R2'] },
    ],
  },
]);

describe('IDS property facet over candidate values[] (#1766)', () => {
  it('passes on a NON-primary candidate reachable only via values[]', () => {
    expect(checkPropertyFacet(facet('R2'), 1, accessor).passed).toBe(true);
  });
  it('passes on the first candidate, fails on a non-candidate', () => {
    expect(checkPropertyFacet(facet('R1'), 1, accessor).passed).toBe(true);
    expect(checkPropertyFacet(facet('R9'), 1, accessor).passed).toBe(false);
  });
});
