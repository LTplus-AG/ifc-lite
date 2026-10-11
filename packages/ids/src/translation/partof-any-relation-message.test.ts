/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A partOf facet without a relation counts any partOf relation (#7401), so
 * its description and failure message must not name containment. Wording
 * from madsik's #7421.
 */

import { describe, it, expect } from 'vitest';
import { checkPartOfFacet } from '../facets/partof-facet.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import { createTranslationService } from './index.js';
import type { IDSPartOfFacet, IDSRequirementResult } from '../types.js';

const facet: IDSPartOfFacet = {
  type: 'partOf',
  relation: 'IfcRelContainedInSpatialStructure',
  anyRelation: true,
  entity: { type: 'entity', name: { type: 'simpleValue', value: 'IFCBUILDINGSTOREY' } },
};

const accessor = createMockAccessor([{ expressId: 1, type: 'IfcWall' }]);

describe('partOf without a relation, translated (#7401)', () => {
  const result = checkPartOfFacet(facet, 1, accessor);

  it('fails with no parent (precondition)', () => {
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PARTOF_RELATION_MISSING');
  });

  it.each([
    ['en', 'part of', 'contained in'],
    ['de', 'Teil von', 'enthalten in'],
    ['fr', 'rattaché à', 'contenu dans'],
    ['it', 'parte di', 'contenuto in'],
  ] as const)('%s names any relation, not containment', (locale, word, containment) => {
    const t = createTranslationService(locale);
    const described = t.describeFacet(facet, 'requirement');
    const failure = t.describeFailure({ failure: result.failure } as unknown as IDSRequirementResult);
    expect(described).toContain(word);
    expect(failure).toContain(word);
    expect(described.toLowerCase()).not.toContain(containment.toLowerCase());
    expect(failure.toLowerCase()).not.toContain(containment.toLowerCase());
  });
});
