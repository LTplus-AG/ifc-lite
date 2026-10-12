/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An entity facet whose name is an `xs:enumeration` (IFCWALL, IFCDOOR)
 * collected its candidates with `ids.push(...getEntitiesByType(value))`.
 * Spreading a type's ids as call arguments throws a RangeError once the
 * type has more than about 125,000 instances (the bound is the engine's
 * stack, about 125k arguments in Node 22), so `validateIDS` rejected and
 * returned no result at all for a large model.
 */

import { filterByEntityFacet } from './entity-facet.js';
import { createMockAccessor } from './test-helpers.js';
import { validateIDS } from '../validation/validator.js';
import type { IDSDocument, IDSEntityFacet, IDSModelInfo, IFCDataAccessor } from '../types.js';

/** Well above the ~125k arguments a spread call survives in Node 22. */
const WALLS = 300_000;

const wallsOrDoors: IDSEntityFacet = {
  type: 'entity',
  name: { type: 'enumeration', values: ['IFCWALL', 'IFCDOOR'] },
};

/** A model with WALLS walls and one door, read only through the type index and the type name. */
function largeModel(): IFCDataAccessor {
  const walls = Array.from({ length: WALLS }, (_, i) => i + 1);
  const door = WALLS + 1;
  return {
    ...createMockAccessor([]),
    getSchemaVersion: () => 'IFC4',
    getEntitiesByType: (type: string) =>
      type.toUpperCase() === 'IFCWALL' ? walls : type.toUpperCase() === 'IFCDOOR' ? [door] : [],
    getEntityType: (id: number) => (id === door ? 'IfcDoor' : id >= 1 && id <= WALLS ? 'IfcWall' : undefined),
  };
}

describe('entity facet with a list naming a type of more than 125,000 instances', () => {
  it('collects every candidate instead of throwing a RangeError', () => {
    const ids = filterByEntityFacet(wallsOrDoors, largeModel());
    expect(ids).toHaveLength(WALLS + 1);
    expect(ids?.[0]).toBe(1);
    expect(ids?.[WALLS]).toBe(WALLS + 1);
  });

  it('lets validateIDS report the specification', async () => {
    const doc: IDSDocument = {
      info: { title: 'Large type' },
      specifications: [
        {
          id: 'spec-0',
          name: 'Walls and doors',
          ifcVersions: ['IFC4'],
          applicability: { facets: [wallsOrDoors] },
          requirements: [],
        },
      ],
    };
    const modelInfo: IDSModelInfo = { modelId: 'large', schemaVersion: 'IFC4', entityCount: WALLS + 1 };

    const report = await validateIDS(doc, largeModel(), modelInfo, { includePassingEntities: false });

    const [result] = report.specificationResults;
    expect(result.error).toBeUndefined();
    expect(result.applicableCount).toBe(WALLS + 1);
    expect(result.status).toBe('pass');
  }, 30_000);
});
