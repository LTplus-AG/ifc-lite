/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { validateIDS } from './validator.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import type {
  IDSDocument,
  IDSSpecification,
  IDSModelInfo,
  IDSSimpleValue,
} from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

function makeDoc(specs: IDSSpecification[]): IDSDocument {
  return {
    info: { title: 'Test IDS' },
    specifications: specs,
  };
}

function makeSpec(
  overrides: Partial<IDSSpecification> = {}
): IDSSpecification {
  return {
    id: 'spec-0',
    name: 'Test Specification',
    ifcVersions: ['IFC4'],
    applicability: {
      facets: [{ type: 'entity', name: sv('IFCWALL') }],
    },
    requirements: [],
    ...overrides,
  };
}

const modelInfo: IDSModelInfo = {
  modelId: 'test-model',
  schemaVersion: 'IFC4',
  entityCount: 10,
};

// ============================================================================
// End-to-end Validation
// ============================================================================

describe('validateIDS — all entities passing', () => {
  it('reports pass when all walls have required name', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'Wall_001' },
      { expressId: 2, type: 'IfcWall', name: 'Wall_002' },
      { expressId: 3, type: 'IfcSlab', name: 'Slab_001' }, // not applicable
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Name') },
          optionality: 'required',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);

    expect(report.summary.totalSpecifications).toBe(1);
    expect(report.summary.passedSpecifications).toBe(1);
    expect(report.summary.failedSpecifications).toBe(0);
    expect(report.specificationResults[0].status).toBe('pass');
    expect(report.specificationResults[0].applicableCount).toBe(2);
    expect(report.specificationResults[0].passedCount).toBe(2);
    expect(report.specificationResults[0].failedCount).toBe(0);
  });
});

describe('validateIDS — some entities failing', () => {
  it('reports fail when some walls lack required name', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'Wall_001' },
      { expressId: 2, type: 'IfcWall' }, // name is missing
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Name') },
          optionality: 'required',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);

    expect(report.summary.failedSpecifications).toBe(1);
    expect(report.specificationResults[0].status).toBe('fail');
    expect(report.specificationResults[0].passedCount).toBe(1);
    expect(report.specificationResults[0].failedCount).toBe(1);
    expect(report.specificationResults[0].passRate).toBe(50);
  });

  it('includes failure reason on failed entity results', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall' }, // missing Name
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Name'), value: sv('Required') },
          optionality: 'required',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const entityResult = report.specificationResults[0].entityResults[0];
    expect(entityResult.passed).toBe(false);
    expect(entityResult.requirementResults[0].status).toBe('fail');
    expect(entityResult.requirementResults[0].failureReason).toBeDefined();
  });
});

// ============================================================================
// Optionality
// ============================================================================

describe('validateIDS — optionality', () => {
  it('optional requirements always pass even when facet fails', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall' }, // no description
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Description') },
          optionality: 'optional',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    expect(report.specificationResults[0].status).toBe('pass');
    const reqResult = report.specificationResults[0].entityResults[0].requirementResults[0];
    expect(reqResult.status).toBe('pass');
  });

  it('prohibited requirements fail when facet passes', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', description: 'Should not exist' },
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Description') },
          optionality: 'prohibited',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    expect(report.specificationResults[0].status).toBe('fail');
    const reqResult = report.specificationResults[0].entityResults[0].requirementResults[0];
    expect(reqResult.status).toBe('fail');
    expect(reqResult.failureReason).toContain('Prohibited');
  });

  it('prohibited requirements pass when facet fails (attribute missing)', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall' }, // no description
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Description') },
          optionality: 'prohibited',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    expect(report.specificationResults[0].status).toBe('pass');
    const reqResult = report.specificationResults[0].entityResults[0].requirementResults[0];
    expect(reqResult.status).toBe('pass');
  });
});

// ============================================================================
// Cardinality
// ============================================================================

describe('validateIDS — cardinality', () => {
  it('passes when entity count satisfies minOccurs', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'W1' },
      { expressId: 2, type: 'IfcWall', name: 'W2' },
    ]);

    const spec = makeSpec({
      minOccurs: 1,
      maxOccurs: 'unbounded',
      requirements: [],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const specResult = report.specificationResults[0];
    expect(specResult.cardinalityResult).toBeDefined();
    expect(specResult.cardinalityResult!.passed).toBe(true);
    expect(specResult.status).toBe('pass');
  });

  it('fails when entity count is below minOccurs', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcSlab' }, // no walls
    ]);

    const spec = makeSpec({
      minOccurs: 1,
      requirements: [],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const specResult = report.specificationResults[0];
    expect(specResult.cardinalityResult).toBeDefined();
    expect(specResult.cardinalityResult!.passed).toBe(false);
    expect(specResult.cardinalityResult!.message).toContain('at least 1');
    expect(specResult.status).toBe('fail');
  });

  it('fails when entity count exceeds maxOccurs', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'W1' },
      { expressId: 2, type: 'IfcWall', name: 'W2' },
      { expressId: 3, type: 'IfcWall', name: 'W3' },
    ]);

    const spec = makeSpec({
      maxOccurs: 2,
      requirements: [],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const specResult = report.specificationResults[0];
    expect(specResult.cardinalityResult!.passed).toBe(false);
    expect(specResult.cardinalityResult!.message).toContain('at most 2');
    expect(specResult.status).toBe('fail');
  });

  it('returns undefined cardinality when no minOccurs/maxOccurs set', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'W1' },
    ]);

    const spec = makeSpec({ requirements: [] });
    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    expect(report.specificationResults[0].cardinalityResult).toBeUndefined();
  });

  it('minOccurs=0 maxOccurs=0 passes when no entities match (prohibited spec)', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcSlab' }, // no walls
    ]);

    const spec = makeSpec({
      minOccurs: 0,
      maxOccurs: 0,
      requirements: [],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const specResult = report.specificationResults[0];
    expect(specResult.cardinalityResult!.passed).toBe(true);
    expect(specResult.status).toBe('pass');
  });
});

// ============================================================================
// Not Applicable
// ============================================================================

describe('validateIDS — not applicable', () => {
  it('returns not_applicable when no entities match and no cardinality', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcSlab' }, // no walls
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Name') },
          optionality: 'required',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    expect(report.specificationResults[0].status).toBe('not_applicable');
    expect(report.specificationResults[0].applicableCount).toBe(0);
  });
});

// ============================================================================
// Multiple Specifications
// ============================================================================

describe('validateIDS — multiple specifications', () => {
  it('validates all specifications independently', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'Wall_001' },
      { expressId: 2, type: 'IfcSlab' }, // slab without name
    ]);

    const wallSpec = makeSpec({
      id: 'spec-walls',
      name: 'Walls need names',
      applicability: {
        facets: [{ type: 'entity', name: sv('IFCWALL') }],
      },
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Name') },
          optionality: 'required',
        },
      ],
    });

    const slabSpec = makeSpec({
      id: 'spec-slabs',
      name: 'Slabs need names',
      applicability: {
        facets: [{ type: 'entity', name: sv('IFCSLAB') }],
      },
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Name') },
          optionality: 'required',
        },
      ],
    });

    const report = await validateIDS(
      makeDoc([wallSpec, slabSpec]),
      accessor,
      modelInfo
    );

    expect(report.summary.totalSpecifications).toBe(2);
    expect(report.specificationResults[0].status).toBe('pass');
    expect(report.specificationResults[1].status).toBe('fail');
    expect(report.summary.passedSpecifications).toBe(1);
    expect(report.summary.failedSpecifications).toBe(1);
  });
});

// ============================================================================
// Empty applicability (applies to all)
// ============================================================================

describe('validateIDS — empty applicability', () => {
  it('applies to all entities when no applicability facets', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'W1' },
      { expressId: 2, type: 'IfcSlab', name: 'S1' },
    ]);

    const spec = makeSpec({
      applicability: { facets: [] },
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Name') },
          optionality: 'required',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    expect(report.specificationResults[0].applicableCount).toBe(2);
    expect(report.specificationResults[0].status).toBe('pass');
  });
});

// ============================================================================
// Options
// ============================================================================

describe('validateIDS — options', () => {
  it('respects maxEntities limit', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'W1' },
      { expressId: 2, type: 'IfcWall', name: 'W2' },
      { expressId: 3, type: 'IfcWall', name: 'W3' },
    ]);

    const spec = makeSpec({ requirements: [] });
    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo, {
      maxEntities: 2,
    });
    // Only 2 entity results, but applicableCount is still 3
    expect(report.specificationResults[0].entityResults).toHaveLength(2);
  });

  it('excludes passing entities when includePassingEntities is false', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'W1' },
      { expressId: 2, type: 'IfcWall' }, // missing name = fail
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'attribute', name: sv('Name') },
          optionality: 'required',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo, {
      includePassingEntities: false,
    });

    // Only failing entities in results
    expect(report.specificationResults[0].entityResults).toHaveLength(1);
    expect(report.specificationResults[0].entityResults[0].passed).toBe(false);
    // But counts still reflect all entities
    expect(report.specificationResults[0].passedCount).toBe(1);
    expect(report.specificationResults[0].failedCount).toBe(1);
  });

  it('calls onProgress callback', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'W1' },
    ]);

    const spec = makeSpec({ requirements: [] });
    const progressCalls: string[] = [];

    await validateIDS(makeDoc([spec]), accessor, modelInfo, {
      onProgress: (p) => {
        progressCalls.push(p.phase);
      },
    });

    expect(progressCalls).toContain('filtering');
    expect(progressCalls).toContain('complete');
  });
});

// ============================================================================
// Report structure
// ============================================================================

describe('validateIDS — report structure', () => {
  it('populates entity result fields correctly', async () => {
    const accessor = createMockAccessor([
      {
        expressId: 1,
        type: 'IfcWall',
        name: 'Wall_001',
        globalId: 'abc123',
      },
    ]);

    const spec = makeSpec({ requirements: [] });
    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const entityResult = report.specificationResults[0].entityResults[0];

    expect(entityResult.expressId).toBe(1);
    expect(entityResult.modelId).toBe('test-model');
    expect(entityResult.entityType).toBe('IfcWall');
    expect(entityResult.entityName).toBe('Wall_001');
    expect(entityResult.globalId).toBe('abc123');
    expect(entityResult.passed).toBe(true);
  });
});
