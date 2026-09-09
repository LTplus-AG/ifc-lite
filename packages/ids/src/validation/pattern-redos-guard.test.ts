/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end: a requirement whose `xs:pattern` facet is
 * catastrophic-backtracking-shaped must surface as a FAILED
 * specification with a visible error, never as a silent PASS or
 * NOT_APPLICABLE — the false-clean failure mode issue #4259 is about.
 * See `validateSpecification`'s `UnsafeRegexPatternError` catch in
 * `validator.ts`.
 */

import { validateIDS } from './validator.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import type {
  IDSDocument,
  IDSSpecification,
  IDSModelInfo,
  IDSSimpleValue,
  IDSPatternConstraint,
} from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });
const patternConstraint = (p: string): IDSPatternConstraint => ({
  type: 'pattern',
  pattern: p,
});

function makeDoc(specs: IDSSpecification[]): IDSDocument {
  return {
    info: { title: 'Test IDS' },
    specifications: specs,
  };
}

const modelInfo: IDSModelInfo = {
  modelId: 'test-model',
  schemaVersion: 'IFC4',
  entityCount: 3,
};

describe('validateIDS — catastrophic xs:pattern requirement', () => {
  it('fails the specification with a visible error, not a silent pass', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'Wall_001' },
      { expressId: 2, type: 'IfcWall', name: 'Wall_002' },
    ]);

    const spec: IDSSpecification = {
      id: 'spec-0',
      name: 'Catastrophic name pattern',
      ifcVersions: ['IFC4'],
      applicability: {
        facets: [{ type: 'entity', name: sv('IFCWALL') }],
      },
      requirements: [
        {
          id: 'req-0',
          // The textbook catastrophic form from issue #4259's own report.
          facet: { type: 'attribute', name: sv('Name'), value: patternConstraint('(a+)+b') },
          optionality: 'required',
        },
      ],
    };

    const start = performance.now();
    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const elapsed = performance.now() - start;

    // Must not hang — proof the guard fired before any backtracking
    // match attempt against either entity's Name value.
    expect(elapsed).toBeLessThan(2000);

    const result = report.specificationResults[0];
    // The core assertion: this must NOT read as 'pass' or
    // 'not_applicable' (both of which a viewer/CLI renders as "no
    // problem here") — it must be a visible failure with a reason.
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/rejected/i);
    expect(report.summary.failedSpecifications).toBe(1);
    expect(report.summary.passedSpecifications).toBe(0);
  });

  it('a legitimate xs:pattern requirement is unaffected', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'Wall-001' },
      { expressId: 2, type: 'IfcWall', name: 'not-a-wall-name' },
    ]);

    const spec: IDSSpecification = {
      id: 'spec-0',
      name: 'Legitimate name pattern',
      ifcVersions: ['IFC4'],
      applicability: {
        facets: [{ type: 'entity', name: sv('IFCWALL') }],
      },
      requirements: [
        {
          id: 'req-0',
          facet: {
            type: 'attribute',
            name: sv('Name'),
            value: patternConstraint('^Wall-[0-9]{3}$'),
          },
          optionality: 'required',
        },
      ],
    };

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const result = report.specificationResults[0];

    expect(result.status).toBe('fail'); // one of two entities matches
    expect(result.error).toBeUndefined();
    expect(result.passedCount).toBe(1);
    expect(result.failedCount).toBe(1);
  });
});
