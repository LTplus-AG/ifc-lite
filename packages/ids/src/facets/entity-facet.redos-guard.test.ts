/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { UnsafeRegexPatternError } from '@ifc-lite/regex-guard';
import { getMatchingEntityTypes } from './entity-facet.js';
import type { IDSPatternConstraint } from '../types.js';

const ALL_TYPES = ['IfcWall', 'IfcWallStandardCase', 'IfcSlab', 'IfcBeam'];

describe('getMatchingEntityTypes(pattern) — ReDoS guard', () => {
  it('rejects a catastrophic-backtracking entity-name pattern', () => {
    const c: IDSPatternConstraint = { type: 'pattern', pattern: '(a+)+b' };
    expect(() => getMatchingEntityTypes(c, ALL_TYPES)).toThrow(UnsafeRegexPatternError);
  });

  it('still resolves a legitimate entity-name pattern', () => {
    const c: IDSPatternConstraint = { type: 'pattern', pattern: 'IfcWall.*' };
    expect(getMatchingEntityTypes(c, ALL_TYPES)).toEqual(['IfcWall', 'IfcWallStandardCase']);
  });
});
