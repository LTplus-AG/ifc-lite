/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7482: one specification that throws used to end the whole run:
 * `validateIDS` caught only `UnsafeRegexPatternError` per specification and
 * rethrew anything else, so every other specification's verdict was lost.
 * Now the specification that cannot be evaluated fails with the reason and
 * the others are reported, as `runRuleSet` does. A host's cancellation
 * (`AbortError`) and an exception from the host's own `onProgress` still end
 * the run: they are host failures, not an unevaluable check.
 */

import { validateIDS } from './validator.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import type { IDSDocument, IDSModelInfo, IDSSpecification, IFCDataAccessor, ValidationProgress } from '../types.js';

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

  it('does not let a later specification pass an element whose property sets could not be read', async () => {
    // Both specifications select walls by Pset_Test.Mark, so they share the
    // applicability property index. Reading wall #2's sets throws; wall #2
    // has no Name, so it can only fail. If the index had marked #2 as folded
    // before the throw, the second specification would drop it and pass.
    const base = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'W-1', properties: [{ psetName: 'Pset_Test', propName: 'Mark', value: 'A' }] },
      { expressId: 2, type: 'IfcWall', properties: [{ psetName: 'Pset_Test', propName: 'Mark', value: 'A' }] },
    ]);
    const accessor: IFCDataAccessor = {
      ...base,
      getPropertySets: (id: number) => {
        if (id === 2) throw new Error('property sets of #2 unreadable');
        return base.getPropertySets(id);
      },
    };
    const markedWalls = (id: string): IDSSpecification => ({
      ...namedSpec(id, 'IFCWALL'),
      applicability: {
        facets: [
          { type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } },
          {
            type: 'property',
            propertySet: { type: 'simpleValue', value: 'Pset_Test' },
            baseName: { type: 'simpleValue', value: 'Mark' },
            value: { type: 'simpleValue', value: 'A' },
          },
        ],
      },
    });
    const twoSpecs: IDSDocument = { info: { title: 'Shared index' }, specifications: [markedWalls('first'), markedWalls('second')] };

    const report = await validateIDS(twoSpecs, accessor, modelInfo);

    for (const result of report.specificationResults) {
      expect(result.status).toBe('fail');
      expect(result.error).toBe('Specification could not be evaluated: property sets of #2 unreadable');
    }
  });

  it("still ends the run on a host's cancellation", async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    await expect(validateIDS(doc, modelThatThrowsOnDoors(abort), modelInfo)).rejects.toBe(abort);
  });

  it("lets an exception from the host's onProgress end the run instead of failing a specification", async () => {
    // Thrown while the first specification checks its walls, so from inside
    // its evaluation: the per-specification catch must not take it.
    const hostFailure = new Error('progress view went away');
    const onProgress = (progress: ValidationProgress) => {
      if (progress.phase === 'validating') throw hostFailure;
    };
    await expect(validateIDS(doc, modelThatThrowsOnDoors(new Error('unused')), modelInfo, { onProgress })).rejects.toBe(
      hostFailure
    );
  });

  it('keeps reporting progress through the guard', async () => {
    const phases: string[] = [];
    const report = await validateIDS(doc, modelThatThrowsOnDoors(new Error('door index unavailable')), modelInfo, {
      onProgress: (progress) => phases.push(progress.phase),
    });
    expect(report.specificationResults.map((r) => r.status)).toEqual(['fail', 'fail', 'pass']);
    expect(phases).toContain('validating');
    expect(phases.at(-1)).toBe('complete');
  });
});
