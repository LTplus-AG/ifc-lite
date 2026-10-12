/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #ISSUE: an entity facet whose name lists a class more than once
 * (`xs:enumeration` IFCWALL, IFCWALL) collected that class's ids once per
 * listed value. Every wall became a candidate twice, so the specification
 * counted and reported it twice (applicable 6 for 3 walls, two rows per
 * wall) and judged minOccurs/maxOccurs against the doubled count.
 * Applicability selects a set of entities: each entity is one candidate,
 * however many listed values return it.
 */

import { filterByEntityFacet } from './entity-facet.js';
import { createMockAccessor } from './test-helpers.js';
import { validateIDS } from '../validation/validator.js';
import type {
  IDSDocument,
  IDSEntityFacet,
  IDSModelInfo,
  IDSSpecification,
  IFCDataAccessor,
} from '../types.js';

const listed = (...values: string[]): IDSEntityFacet => ({
  type: 'entity',
  name: { type: 'enumeration', values },
});

/** Three walls (W-3 has no Name) and a door. */
const model = (): IFCDataAccessor =>
  createMockAccessor([
    { expressId: 1, type: 'IfcWall', name: 'W-1' },
    { expressId: 2, type: 'IfcWall', name: 'W-2' },
    { expressId: 3, type: 'IfcWall' },
    { expressId: 4, type: 'IfcDoor', name: 'D-1' },
  ]);

describe('filterByEntityFacet with a class listed more than once (#ISSUE)', () => {
  it('returns each wall once for IFCWALL, IFCWALL', () => {
    expect(filterByEntityFacet(listed('IFCWALL', 'IFCWALL'), model())).toEqual([1, 2, 3]);
  });

  it('returns each wall once when the repeat differs only in case', () => {
    expect(filterByEntityFacet(listed('IFCWALL', 'IfcWall'), model())).toEqual([1, 2, 3]);
  });

  it('returns each wall once for a class repeated around other classes', () => {
    expect(
      filterByEntityFacet(listed('IFCWALL', 'IFCSLAB', 'IFCWALL', 'IFCWALL'), model())
    ).toEqual([1, 2, 3]);
  });

  it("returns each entity once when the accessor's type lists overlap, in first-listed order", () => {
    // IFCDataAccessor does not require getEntitiesByType to be exact-class:
    // this one answers IFCWALL with its IFCWALLSTANDARDCASE (id 5) as well.
    const subtypeInclusive: IFCDataAccessor = {
      ...model(),
      getEntitiesByType: (type: string) => {
        const upper = type.toUpperCase();
        return upper === 'IFCWALL' ? [1, 2, 3, 5] : upper === 'IFCWALLSTANDARDCASE' ? [5] : [];
      },
    };
    expect(
      filterByEntityFacet(listed('IFCWALLSTANDARDCASE', 'IFCWALL'), subtypeInclusive)
    ).toEqual([5, 1, 2, 3]);
  });

  it('keeps a list of distinct classes as before: every id, in listed order', () => {
    expect(filterByEntityFacet(listed('IFCDOOR', 'IFCWALL'), model())).toEqual([4, 1, 2, 3]);
    expect(filterByEntityFacet(listed('IFCSLAB'), model())).toEqual([]);
  });
});

describe('validateIDS with a class listed twice (#ISSUE)', () => {
  const modelInfo: IDSModelInfo = { modelId: 'listed-twice', schemaVersion: 'IFC4', entityCount: 4 };

  const spec = (overrides: Partial<IDSSpecification> = {}): IDSSpecification => ({
    id: 'spec-0',
    name: 'Walls have a Name',
    ifcVersions: ['IFC4'],
    applicability: { facets: [listed('IFCWALL', 'IFCWALL')] },
    requirements: [
      {
        id: 'req-0',
        facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' } },
        optionality: 'required',
      },
    ],
    minOccurs: 0,
    maxOccurs: 'unbounded',
    ...overrides,
  });

  const run = async (specification: IDSSpecification, includePassingEntities = true) => {
    const doc: IDSDocument = { info: { title: 'Listed twice' }, specifications: [specification] };
    const report = await validateIDS(doc, model(), modelInfo, { includePassingEntities });
    return report.specificationResults[0];
  };

  it('counts and reports each wall once', async () => {
    const result = await run(spec());
    expect([result.status, result.applicableCount, result.passedCount, result.failedCount]).toEqual([
      'fail', 3, 2, 1,
    ]);
    expect(result.entityResults.map((e) => e.expressId)).toEqual([1, 2, 3]);
  });

  it('counts each wall once without the passing entities', async () => {
    const result = await run(spec(), false);
    expect([result.applicableCount, result.passedCount, result.failedCount]).toEqual([3, 2, 1]);
    expect(result.entityResults.map((e) => e.expressId)).toEqual([3]);
  });

  it('judges minOccurs and maxOccurs on the distinct walls', async () => {
    const noRequirement = { requirements: [] };
    const atMostFive = await run(spec({ ...noRequirement, maxOccurs: 5 }));
    expect([atMostFive.status, atMostFive.cardinalityResult?.actualCount]).toEqual(['pass', 3]);

    const atLeastFour = await run(spec({ ...noRequirement, minOccurs: 4 }));
    expect(atLeastFour.status).toBe('fail');
    expect(atLeastFour.cardinalityResult?.message).toBe('Expected at least 4, found 3');
  });

  it('spends maxEntities on distinct entities, so the door is still checked', async () => {
    // With the walls collected twice, a limit of 4 took W-1, W-2, W-3 and W-1
    // again, and the door was never checked.
    const doc: IDSDocument = {
      info: { title: 'Listed twice' },
      specifications: [spec({ applicability: { facets: [listed('IFCWALL', 'IFCWALL', 'IFCDOOR')] } })],
    };
    const report = await validateIDS(doc, model(), modelInfo, { maxEntities: 4 });
    expect(report.specificationResults[0].entityResults.map((e) => e.expressId)).toEqual([1, 2, 3, 4]);
  });

  it('fails each wall of a prohibited specification once', async () => {
    const result = await run(spec({ requirements: [], maxOccurs: 0 }));
    expect([result.status, result.applicableCount, result.failedCount]).toEqual(['fail', 3, 3]);
    expect(result.entityResults.map((e) => e.expressId)).toEqual([1, 2, 3]);
  });
});
