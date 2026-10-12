/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One specification that throws used to end the whole run: `validateIDS`
 * caught only `UnsafeRegexPatternError` per specification and rethrew
 * anything else, so every other specification's verdict was lost. Now the
 * specification that cannot be evaluated fails with the reason and the
 * others are reported, as `runRuleSet` does; a host's cancellation
 * (`AbortError`) still ends the run.
 */

import { validateIDS } from './validator.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import type { IDSDocument, IDSModelInfo, IDSSpecification, IFCDataAccessor } from '../types.js';

const modelInfo: IDSModelInfo = { modelId: 'test-model', schemaVersion: 'IFC4', entityCount: 3 };

function namedSpec(id: string, entity: string): IDSSpecification {
  return {
    id,
    name: `${entity} has a name`,
    ifcVersions: ['IFC4'],
    applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: entity } }] },
    requirements: [
      { id: `${id}-req`, facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' } }, optionality: 'required' },
    ],
  };
}

const doc: IDSDocument = {
  info: { title: 'Isolation' },
  specifications: [namedSpec('walls', 'IFCWALL'), namedSpec('doors', 'IFCDOOR'), namedSpec('slabs', 'IFCSLAB')],
};

/** Two walls and a slab; reading the doors throws `error`. */
function modelThatThrowsOnDoors(error: unknown): IFCDataAccessor {
  const base = createMockAccessor([
    { expressId: 1, type: 'IfcWall', name: 'W-1' },
    { expressId: 2, type: 'IfcWall' },
    { expressId: 3, type: 'IfcSlab', name: 'S-1' },
  ]);
  return {
    ...base,
    getEntitiesByType: (type: string) => {
      if (type.toUpperCase() === 'IFCDOOR') throw error;
      return base.getEntitiesByType(type);
    },
  };
}

describe('a specification that throws (validateIDS)', () => {
  it('fails that specification with the reason and reports the others', async () => {
    const report = await validateIDS(doc, modelThatThrowsOnDoors(new Error('door index unavailable')), modelInfo);

    const [walls, doors, slabs] = report.specificationResults;
    expect(report.specificationResults).toHaveLength(3);

    expect(walls.error).toBeUndefined();
    expect(walls.status).toBe('fail');
    expect([walls.applicableCount, walls.passedCount, walls.failedCount]).toEqual([2, 1, 1]);

    expect(doors.status).toBe('fail');
    expect(doors.error).toBe('Specification could not be evaluated: door index unavailable');
    expect(doors.entityResults).toEqual([]);

    expect(slabs.error).toBeUndefined();
    expect(slabs.status).toBe('pass');
  });

  it('keeps a thrown non-Error value as the reason', async () => {
    const report = await validateIDS(doc, modelThatThrowsOnDoors('no doors'), modelInfo);
    expect(report.specificationResults[1].error).toBe('Specification could not be evaluated: no doors');
    expect(report.specificationResults[2].status).toBe('pass');
  });

  it("still ends the run on a host's cancellation", async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    await expect(validateIDS(doc, modelThatThrowsOnDoors(abort), modelInfo)).rejects.toBe(abort);
  });
});
