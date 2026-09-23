/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end: a requirement whose `xs:pattern` facet uses XSD
 * character-class subtraction (`[a-z-[aeiou]]`) must reject exactly the
 * values it excludes (#5183). The matcher used to drop the exclusion and
 * evaluate the positive class instead, so a consonants-only pattern
 * accepted `"aeiou"`, the exact value it was written to reject. It is now
 * translated exactly (`translateSubtraction` in
 * `constraints/xsd-regex.ts`); a subtraction that cannot be delimited is
 * refused and surfaces as a failed specification naming the construct.
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
  entityCount: 2,
};

function namePatternSpec(pattern: string): IDSSpecification {
  return {
    id: 'spec-0',
    name: 'Name pattern',
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
          value: patternConstraint(pattern),
        },
        optionality: 'required',
      },
    ],
  };
}

describe('validateIDS — xs:pattern with XSD character-class subtraction (#5183)', () => {
  it('fails the excluded value and passes an allowed one, with no error', async () => {
    const accessor = createMockAccessor([
      // Nothing but vowels: exactly what a consonants-only pattern must
      // reject. Under the old desubtraction this value passed.
      { expressId: 1, type: 'IfcWall', name: 'aeiou' },
      { expressId: 2, type: 'IfcWall', name: 'xyz' },
    ]);

    const report = await validateIDS(makeDoc([namePatternSpec('[a-z-[aeiou]]+')]), accessor, modelInfo);
    const result = report.specificationResults[0];

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('fail');
    expect(result.failedCount).toBe(1);
    expect(result.passedCount).toBe(1);
    const failed = result.entityResults.find((e) => !e.passed);
    expect(failed?.expressId).toBe(1);
  });

  it('a subtraction that cannot be delimited fails the specification and names the construct', async () => {
    const accessor = createMockAccessor([{ expressId: 1, type: 'IfcWall', name: 'xyz' }]);

    const report = await validateIDS(makeDoc([namePatternSpec('[a-z-[aeiou]+')]), accessor, modelInfo);
    const result = report.specificationResults[0];

    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/XSD character-class subtraction is not supported in JS regex/);
    expect(report.summary.failedSpecifications).toBe(1);
  });

  it('a pattern without subtraction is unaffected', async () => {
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcWall', name: 'xyz' },
      { expressId: 2, type: 'IfcWall', name: 'aeiou' },
    ]);

    const spec: IDSSpecification = {
      id: 'spec-0',
      name: 'Consonants-only name pattern, no subtraction',
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
            value: patternConstraint('[a-z]+'),
          },
          optionality: 'required',
        },
      ],
    };

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const result = report.specificationResults[0];

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('pass');
    expect(result.passedCount).toBe(2);
    expect(result.failedCount).toBe(0);
  });
});
