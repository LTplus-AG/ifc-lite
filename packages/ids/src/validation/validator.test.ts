/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcParser } from '@ifc-lite/parser';
import type { IfcDataStore, EntityRef } from '@ifc-lite/parser';
import { validateIDS } from './validator.js';
import { parseIDS } from '../parser/xml-parser.js';
import {
  createDataAccessor,
  type EntityVisibilityView,
} from '../bridge/data-accessor.js';
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
    // No-regression pin (#5212): a genuinely passing spec still reports 100.
    expect(report.specificationResults[0].passRate).toBe(100);
    expect(report.summary.overallPassRate).toBe(100);
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

  it('optional requirement fails when facet is present but wrong (not merely absent)', async () => {
    // `optional` pardons a wholly-absent facet, but must NOT pardon bad
    // data: a present Description with the wrong value is an
    // ATTRIBUTE_VALUE_MISMATCH, not an ATTRIBUTE_MISSING, so it must
    // fail rather than be waved through by the missingFailures allowlist.
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', description: 'Wrong value' },
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: {
            type: 'attribute',
            name: sv('Description'),
            value: sv('Expected value'),
          },
          optionality: 'optional',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const reqResult = report.specificationResults[0].entityResults[0].requirementResults[0];
    expect(reqResult.failure?.type).toBe('ATTRIBUTE_VALUE_MISMATCH');
    expect(reqResult.status).toBe('fail');
    expect(report.specificationResults[0].status).toBe('fail');
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

  it('optional entity requirement passes when predefinedType is wholly absent', async () => {
    // PREDEFINED_TYPE_MISSING means "this entity has no PredefinedType
    // and no fallback ObjectType at all" — the same "wholly absent"
    // shape as ATTRIBUTE_MISSING, so `optional` must give it a pass
    // rather than treating it as bad data.
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall' }, // no objectType, no predefinedType
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: { type: 'entity', name: sv('IFCWALL'), predefinedType: sv('SOLIDWALL') },
          optionality: 'optional',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const reqResult = report.specificationResults[0].entityResults[0].requirementResults[0];
    expect(reqResult.failure?.type).toBe('PREDEFINED_TYPE_MISSING');
    expect(reqResult.status).toBe('pass');
    expect(report.specificationResults[0].status).toBe('pass');
  });

  it('optional partOf requirement passes when parent predefinedType is wholly absent', async () => {
    // Same "wholly absent" shape as above, one level removed: the
    // relation exists (a parent was found) but the parent's own
    // PredefinedType attribute is unset.
    const accessor = createMockAccessor([
      {
        expressId: 1,
        type: 'IfcWall',
        parent: {
          expressId: 2,
          type: 'IfcBuildingStorey',
          relation: 'IfcRelContainedInSpatialStructure',
          // predefinedType intentionally omitted
        },
      },
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: {
            type: 'partOf',
            relation: 'IfcRelContainedInSpatialStructure',
            entity: { type: 'entity', name: sv('IFCBUILDINGSTOREY'), predefinedType: sv('BASEMENT') },
          },
          optionality: 'optional',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const reqResult = report.specificationResults[0].entityResults[0].requirementResults[0];
    expect(reqResult.failure?.type).toBe('PARTOF_PREDEFINED_TYPE_MISSING');
    expect(reqResult.status).toBe('pass');
    expect(report.specificationResults[0].status).toBe('pass');
  });

  it('optional property requirement passes when the entity has no pset at all (not merely the property)', async () => {
    // PSET_MISSING means the entity carries zero property sets — a
    // stronger "wholly absent" shape than PROPERTY_MISSING (pset
    // present, named property missing). `optional` must pardon this,
    // exactly like it pardons ATTRIBUTE_MISSING / PROPERTY_MISSING.
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall' }, // no `properties` at all -> getPropertySets() === []
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: {
            type: 'property',
            propertySet: sv('Pset_WallCommon'),
            baseName: sv('FireRating'),
          },
          optionality: 'optional',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const reqResult = report.specificationResults[0].entityResults[0].requirementResults[0];
    expect(reqResult.failure?.type).toBe('PSET_MISSING');
    expect(reqResult.status).toBe('pass');
    expect(report.specificationResults[0].status).toBe('pass');
  });

  it('optional partOf requirement passes when the entity has no parent relation at all', async () => {
    // PARTOF_RELATION_MISSING means the entity has no parent under the
    // requested relation whatsoever — the relation itself is absent,
    // not merely pointing at the wrong entity. `optional` must pardon
    // this "wholly absent" shape the same way it pardons the sibling
    // *_MISSING failure types.
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall' }, // no `parent` at all -> getParent() === undefined
    ]);

    const spec = makeSpec({
      requirements: [
        {
          id: 'req-0',
          facet: {
            type: 'partOf',
            relation: 'IfcRelContainedInSpatialStructure',
            entity: { type: 'entity', name: sv('IFCBUILDINGSTOREY') },
          },
          optionality: 'optional',
        },
      ],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const reqResult = report.specificationResults[0].entityResults[0].requirementResults[0];
    expect(reqResult.failure?.type).toBe('PARTOF_RELATION_MISSING');
    expect(reqResult.status).toBe('pass');
    expect(report.specificationResults[0].status).toBe('pass');
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

  // Issue #5212: `minOccurs: 1` with zero matching entities used to report
  // `passRate: 100` (the `totalEntities === 0` default) next to
  // `status: 'fail'` — both at the per-spec and the report-summary level.
  it('#5212 — minOccurs unmet with zero matches reports passRate 0, not 100', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcSlab' }, // no walls
    ]);

    const spec = makeSpec({
      minOccurs: 1,
      requirements: [],
    });

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const specResult = report.specificationResults[0];
    expect(specResult.status).toBe('fail');
    expect(specResult.applicableCount).toBe(0);
    expect(specResult.passRate).toBe(0);

    expect(report.summary.failedSpecifications).toBe(1);
    expect(report.summary.overallPassRate).toBe(0);
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

  // Issue #5212: three walls that each individually satisfy their (empty)
  // requirements, but exceed `maxOccurs: 2` — `passedCount === totalEntities
  // === 3` made the old formula land on `passRate: 100` while `status` was
  // `'fail'`, and `failedSpecifications: 1` / `overallPassRate: 100`
  // disagreed in the same summary object.
  it('#5212 — maxOccurs exceeded with no per-entity failures reports passRate 0, not 100', async () => {
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
    expect(specResult.status).toBe('fail');
    expect(specResult.applicableCount).toBe(3);
    expect(specResult.passedCount).toBe(3);
    expect(specResult.failedCount).toBe(0);
    expect(specResult.passRate).toBe(0);

    expect(report.summary.failedSpecifications).toBe(1);
    expect(report.summary.totalEntitiesPassed).toBe(3);
    expect(report.summary.totalEntitiesFailed).toBe(0);
    expect(report.summary.overallPassRate).toBe(0);
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
    // Documented behaviour (#5212): `not_applicable` is left at the
    // `totalEntities === 0` default of 100, unlike the `'fail'` branch
    // (minOccurs unmet) above, which is now 0. `not_applicable` is a
    // third state distinct from a real pass, and collapsing it into 100
    // is still arguably misleading — see the fix's changeset/PR notes for
    // why this was left as a value-only, shape-preserving fix.
    expect(report.specificationResults[0].passRate).toBe(100);
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

// ============================================================================
// Unparseable bounds facet — the real user-visible message
//
// A present-but-unparseable `xs:restriction` facet (e.g.
// `<xs:minInclusive value="not-a-number"/>`) fails closed everywhere,
// but the ORIGINAL fix only routed the clear "this xs:restriction is
// malformed" message through `getConstraintMismatchReason`, which
// nothing in the real `validateIDS` path ever calls. The actual
// `attribute-facet.ts` path builds `failureReason`/`expectedValue` via
// `formatFailureReason` → `facet.expected` → `formatConstraint` →
// `formatBounds`, which used to fall through to its `'any value'`
// default whenever every numeric field was `undefined` — producing the
// self-contradictory "does not match expected any value" for a
// restriction that is rejecting every value. These tests exercise that
// exact path (XML → `parseIDS` → `validateIDS`), not
// `getConstraintMismatchReason` directly.
// ============================================================================
describe('validateIDS — unparseable bounds facet (issue #4231)', () => {
  const malformedXml = `<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute>
          <name><simpleValue>Name</simpleValue></name>
          <value>
            <xs:restriction>
              <xs:minInclusive value="not-a-number"/>
            </xs:restriction>
          </value>
        </attribute>
      </requirements>
    </specification>
  </specifications>
</ids>`;

  const wellFormedXml = malformedXml
    .replace('<xs:minInclusive value="not-a-number"/>', '<xs:minInclusive value="10"/>\n              <xs:maxInclusive value="20"/>');

  it('names the broken facet in failureReason/expectedValue instead of claiming "any value"', async () => {
    const doc = parseIDS(malformedXml);
    const accessor = createMockAccessor([{ expressId: 1, type: 'IfcWall', name: '0' }]);
    const report = await validateIDS(doc, accessor, modelInfo);
    const result = report.specificationResults[0].entityResults[0].requirementResults[0];

    expect(result.status).toBe('fail');
    expect(result.failureReason).not.toContain('any value');
    expect(result.expectedValue).not.toBe('any value');
    expect(result.expectedValue).toContain('xs:minInclusive="not-a-number"');
    expect(result.expectedValue).toContain('did not parse as a number');
    expect(result.failureReason).toContain('xs:minInclusive="not-a-number"');
  });

  it('leaves a well-formed restriction failure message unchanged', async () => {
    const doc = parseIDS(wellFormedXml);
    const accessor = createMockAccessor([{ expressId: 1, type: 'IfcWall', name: '0' }]);
    const report = await validateIDS(doc, accessor, modelInfo);
    const result = report.specificationResults[0].entityResults[0].requirementResults[0];

    expect(result.status).toBe('fail');
    expect(result.expectedValue).toBe('between 10 and 20');
    expect(result.failureReason).toBe(
      'Attribute "Name" value "0" does not match expected between 10 and 20'
    );
  });
});

// ============================================================================
// Generalised report shape (#5138 §5) — through a real parsed store, not
// the mock accessor: proves the wiring `validator.ts` now writes
// (`source`/`modelInfo` array) end to end, not just against a hand-built
// IDSRequirement/IDSSpecification fixture.
// ============================================================================

const WALL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0Wall00000000000000001',$,'Wall_001',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

describe('validateIDS — generalised report shape', () => {
  it('an IDS run reports source.kind "ids" (carrying the validated document) and exactly one modelInfo entry', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(WALL_IFC).buffer as ArrayBuffer,
    );
    const accessor = createDataAccessor(store);
    const spec = makeSpec({
      requirements: [
        { id: 'req-0', facet: { type: 'attribute', name: sv('Name') }, optionality: 'required' },
      ],
    });
    const document = makeDoc([spec]);

    const report = await validateIDS(document, accessor, {
      modelId: 'wall-fixture', schemaVersion: 'IFC4', entityCount: store.entityCount,
    });

    expect(report.source.kind).toBe('ids');
    expect(report.source.kind === 'ids' && report.source.document).toBe(document);
    expect(report.modelInfo.length).toBe(1);
    expect(report.modelInfo[0]).toEqual({
      modelId: 'wall-fixture', schemaVersion: 'IFC4', entityCount: store.entityCount,
    });
    expect(report.specificationResults[0].applicableCount).toBe(1);
    expect(report.specificationResults[0].status).toBe('pass');
  });
});

// ============================================================================
// Tombstone-aware enumeration (#5184)
// ============================================================================

/**
 * Three-entity store — ids 1, 2, 3 — mirroring the issue's own executed
 * repro (`store before delete: entityIndex.byId keys [ 1, 2, 3 ]`,
 * `accessor.getAllEntityIds() [ 1, 2, 3 ]`, `applicableCount: 3`).
 */
function makeThreeWallStore(): IfcDataStore {
  const byId = new Map<number, EntityRef>([
    [1, { expressId: 1, type: 'IfcWall', byteOffset: 0, byteLength: 0, lineNumber: 1 }],
    [2, { expressId: 2, type: 'IfcWall', byteOffset: 0, byteLength: 0, lineNumber: 2 }],
    [3, { expressId: 3, type: 'IfcWall', byteOffset: 0, byteLength: 0, lineNumber: 3 }],
  ]);
  return {
    schemaVersion: 'IFC4',
    source: new Uint8Array(),
    entities: {
      getTypeName: (id: number) => byId.get(id)?.type,
      getObjectType: () => undefined,
      getName: () => undefined,
      getGlobalId: () => undefined,
      getDescription: () => undefined,
    },
    entityIndex: { byId, byType: new Map([['IFCWALL', [1, 2, 3]]]) },
    relationships: { getRelated: () => [] },
  } as unknown as IfcDataStore;
}

function tombstoneView(ids: number[]): EntityVisibilityView {
  const t = new Set(ids);
  return { isDeleted: (id: number) => t.has(id), getNewEntities: () => [] };
}

describe('validateIDS — tombstoned entity excluded from enumeration (#5184)', () => {
  // Applicability with NO entity facet, exactly the issue's own repro
  // shape ("a specification whose applicability has no entity facet"),
  // so `findApplicableEntities` calls `accessor.getAllEntityIds()`
  // directly (validator.ts's `applicabilityFacets.length === 0` branch).
  const specWithNoEntityFacet: IDSSpecification = {
    id: 'spec-0',
    name: 'Every entity must have a Name',
    ifcVersions: ['IFC4'],
    applicability: { facets: [] },
    // Pinned so the fix must actually change `applicableCount`, not just
    // avoid an error: 3 source entities, minOccurs 3. Before the fix,
    // the tombstoned entity is still counted (applicableCount 3, cardinality
    // wrongly satisfied); after the fix it is 2 (cardinality correctly fails).
    minOccurs: 3,
    requirements: [
      { id: 'req-0', facet: { type: 'attribute', name: sv('Name') }, optionality: 'optional' },
    ],
  };

  it('applicableCount excludes the tombstoned entity (pinned: 2, not 3)', async () => {
    const accessor = createDataAccessor(makeThreeWallStore(), undefined, tombstoneView([2]));
    const report = await validateIDS(makeDoc([specWithNoEntityFacet]), accessor, modelInfo);
    expect(report.specificationResults[0].applicableCount).toBe(2);
  });

  it('the cardinality message reflects the corrected count, not the pre-tombstone one', async () => {
    const accessor = createDataAccessor(makeThreeWallStore(), undefined, tombstoneView([2]));
    const report = await validateIDS(makeDoc([specWithNoEntityFacet]), accessor, modelInfo);
    const cardinality = report.specificationResults[0].cardinalityResult;
    expect(cardinality?.passed).toBe(false);
    expect(cardinality?.actualCount).toBe(2);
    expect(cardinality?.message).toBe('Expected at least 3, found 2');
  });

  it('an accessor built with no entityVisibility argument still counts the tombstoned id (no-regression pin)', async () => {
    const accessor = createDataAccessor(makeThreeWallStore());
    const report = await validateIDS(makeDoc([specWithNoEntityFacet]), accessor, modelInfo);
    expect(report.specificationResults[0].applicableCount).toBe(3);
    expect(report.specificationResults[0].cardinalityResult?.passed).toBe(true);
  });
});

// ============================================================================
// Tombstone-aware enumeration via `getEntitiesByType` (#5184 follow-up)
//
// `specWithNoEntityFacet` above (no applicability facet at all) is the
// MINORITY shape — it is the only case that routes through
// `getAllEntityIds()`. A real-world IDS spec almost always names an entity
// type (`<entity><name><simpleValue>IFCWALL</simpleValue></name></entity>`),
// which `findApplicableEntities` resolves via `filterByEntityFacet` ->
// `accessor.getEntitiesByType()` (`entity-facet.ts`'s `simpleValue` branch
// for one type, `enumeration` branch for several) and NEVER falls back to
// `getAllEntityIds()` for. These tests exercise that dominant path
// directly — `makeSpec`'s default applicability is already an entity
// `simpleValue` facet naming `IFCWALL`.
// ============================================================================

describe('validateIDS — tombstoned entity excluded via getEntitiesByType (#5184 follow-up)', () => {
  // `makeSpec()`'s default applicability: { type: 'entity', name: sv('IFCWALL') }
  const specEntityTyped: IDSSpecification = makeSpec({
    id: 'spec-typed',
    minOccurs: 3,
    requirements: [
      { id: 'req-0', facet: { type: 'attribute', name: sv('Name') }, optionality: 'optional' },
    ],
  });

  it('applicableCount excludes the tombstoned entity for an entity-typed (simpleValue) spec (pinned: 2, not 3)', async () => {
    const accessor = createDataAccessor(makeThreeWallStore(), undefined, tombstoneView([2]));
    const report = await validateIDS(makeDoc([specEntityTyped]), accessor, modelInfo);
    expect(report.specificationResults[0].applicableCount).toBe(2);
    expect(report.specificationResults[0].cardinalityResult?.passed).toBe(false);
  });

  it('an accessor built with no entityVisibility argument still counts the tombstoned id through getEntitiesByType (no-regression pin)', async () => {
    const accessor = createDataAccessor(makeThreeWallStore());
    const report = await validateIDS(makeDoc([specEntityTyped]), accessor, modelInfo);
    expect(report.specificationResults[0].applicableCount).toBe(3);
    expect(report.specificationResults[0].cardinalityResult?.passed).toBe(true);
  });

  /**
   * Store with two entity types, id 2 (a wall) tombstoned, exercising the
   * `enumeration` branch of `filterByEntityFacet` (`entity-facet.ts`'s
   * `constraint.type === 'enumeration'` loop, each iteration a separate
   * `getEntitiesByType` call whose results are concatenated).
   */
  function makeWallAndDoorStore(): IfcDataStore {
    const byId = new Map<number, EntityRef>([
      [1, { expressId: 1, type: 'IfcWall', byteOffset: 0, byteLength: 0, lineNumber: 1 }],
      [2, { expressId: 2, type: 'IfcWall', byteOffset: 0, byteLength: 0, lineNumber: 2 }],
      [3, { expressId: 3, type: 'IfcDoor', byteOffset: 0, byteLength: 0, lineNumber: 3 }],
    ]);
    return {
      schemaVersion: 'IFC4',
      source: new Uint8Array(),
      entities: {
        getTypeName: (id: number) => byId.get(id)?.type,
        getObjectType: () => undefined,
        getName: () => undefined,
        getGlobalId: () => undefined,
        getDescription: () => undefined,
      },
      entityIndex: {
        byId,
        byType: new Map([
          ['IFCWALL', [1, 2]],
          ['IFCDOOR', [3]],
        ]),
      },
      relationships: { getRelated: () => [] },
    } as unknown as IfcDataStore;
  }

  const specEnumerationTyped: IDSSpecification = makeSpec({
    id: 'spec-enum',
    applicability: {
      facets: [
        { type: 'entity', name: { type: 'enumeration', values: ['IFCWALL', 'IFCDOOR'] } },
      ],
    },
    minOccurs: 3,
    requirements: [
      { id: 'req-0', facet: { type: 'attribute', name: sv('Name') }, optionality: 'optional' },
    ],
  });

  it('applicableCount excludes the tombstoned entity for an enumeration entity facet naming two types (pinned: 2, not 3)', async () => {
    const accessor = createDataAccessor(makeWallAndDoorStore(), undefined, tombstoneView([2]));
    const report = await validateIDS(makeDoc([specEnumerationTyped]), accessor, modelInfo);
    expect(report.specificationResults[0].applicableCount).toBe(2);
    expect(report.specificationResults[0].cardinalityResult?.passed).toBe(false);
  });

  it('an accessor with no entityVisibility argument still counts the tombstoned id through the enumeration branch (no-regression pin)', async () => {
    const accessor = createDataAccessor(makeWallAndDoorStore());
    const report = await validateIDS(makeDoc([specEnumerationTyped]), accessor, modelInfo);
    expect(report.specificationResults[0].applicableCount).toBe(3);
    expect(report.specificationResults[0].cardinalityResult?.passed).toBe(true);
  });
});

// ============================================================================
// IFC2X3 mapped-alias path (pin, #5184 follow-up)
//
// `filterByEntityFacet` returns `undefined` (full scan) for a
// `simpleValue`/`enumeration` entity facet naming an IFC2X3-mapped alias
// (`entity-facet.ts`), so `findApplicableEntities` falls back to
// `accessor.getAllEntityIds()` rather than `getEntitiesByType()`. That
// method already had the tombstone filter before this follow-up fix. This
// is a PIN, not a new fix: it proves the alias path stayed tombstone-safe
// while `getEntitiesByType` was being changed, not that it was fixed here.
// ============================================================================

describe('validateIDS — IFC2X3 mapped-alias path stays tombstone-safe (pin)', () => {
  /**
   * Two IFC2X3 `IfcFurnishingElement` occurrences (ids 1, 2), both typed by
   * an `IfcFurnitureType` (id 20) via `IfcRelDefinesByType` — the pairing
   * `IFCFURNITURE` maps to in `ifc2x3-type-mapping.ts`'s ROWS table. Id 2
   * is tombstoned. The spec's applicability names the alias `IFCFURNITURE`
   * directly, which IFC2X3 models never have as an actual entity type —
   * only `matchesIfc2x3Mapping` can match it.
   */
  function makeIfc2x3FurnitureStore(): IfcDataStore {
    const byId = new Map<number, EntityRef>([
      [1, { expressId: 1, type: 'IfcFurnishingElement', byteOffset: 0, byteLength: 0, lineNumber: 1 }],
      [2, { expressId: 2, type: 'IfcFurnishingElement', byteOffset: 0, byteLength: 0, lineNumber: 2 }],
      [20, { expressId: 20, type: 'IfcFurnitureType', byteOffset: 0, byteLength: 0, lineNumber: 3 }],
    ]);
    return {
      schemaVersion: 'IFC2X3',
      source: new Uint8Array(),
      entities: {
        getTypeName: (id: number) => byId.get(id)?.type,
        getObjectType: () => undefined,
        getName: () => undefined,
        getGlobalId: () => undefined,
        getDescription: () => undefined,
      },
      entityIndex: {
        byId,
        byType: new Map([
          ['IFCFURNISHINGELEMENT', [1, 2]],
          ['IFCFURNITURETYPE', [20]],
        ]),
      },
      // Both occurrences (1, 2) are related to the type object (20) via
      // IfcRelDefinesByType, 'inverse' direction — the only relation
      // `getTypeEntityType` (entity-facet.ts's `matchesIfc2x3Mapping`)
      // consults. The third argument (RelationshipType) is ignored by
      // this stub; every call this test triggers is a DefinesByType
      // inverse lookup.
      relationships: {
        getRelated: (id: number) => (id === 1 || id === 2 ? [20] : []),
      },
    } as unknown as IfcDataStore;
  }

  const specAlias: IDSSpecification = makeSpec({
    id: 'spec-alias',
    applicability: { facets: [{ type: 'entity', name: sv('IFCFURNITURE') }] },
    minOccurs: 2,
    requirements: [
      { id: 'req-0', facet: { type: 'attribute', name: sv('Name') }, optionality: 'optional' },
    ],
  });

  it('matches the aliased occurrence/type pair at all (sanity: 2, no tombstone)', async () => {
    const accessor = createDataAccessor(makeIfc2x3FurnitureStore());
    const report = await validateIDS(makeDoc([specAlias]), accessor, {
      ...modelInfo,
      schemaVersion: 'IFC2X3',
    });
    expect(report.specificationResults[0].applicableCount).toBe(2);
  });

  it('excludes the tombstoned occurrence through the alias full-scan fallback (pinned: 1, not 2)', async () => {
    const accessor = createDataAccessor(makeIfc2x3FurnitureStore(), undefined, tombstoneView([2]));
    const report = await validateIDS(makeDoc([specAlias]), accessor, {
      ...modelInfo,
      schemaVersion: 'IFC2X3',
    });
    expect(report.specificationResults[0].applicableCount).toBe(1);
    expect(report.specificationResults[0].cardinalityResult?.passed).toBe(false);
  });
});
