/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end: a requirement whose `xs:pattern` facet uses XSD
 * character-class subtraction (`[a-z-[aeiou]]`) must surface as a
 * FAILED specification naming the unsupported construct, never as a
 * silent PASS — issue #5183. The matcher used to drop the exclusion
 * and evaluate the positive class instead, so a consonants-only
 * pattern accepted `"aeiou"`, the exact value it was written to
 * reject. See `buildPatternRegex`'s `UnsafeRegexPatternError` throw in
 * `constraints/match-family.ts` and `validateSpecification`'s catch of
 * it in `validator.ts`.
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

describe('validateIDS — xs:pattern with XSD character-class subtraction', () => {
  it('fails the specification and names the unsupported construct, not a silent pass', async () => {
    const accessor = createMockAccessor([
      // Nothing but vowels — exactly what a consonants-only pattern
      // must reject. Under the old desubtraction the pattern silently
      // became `[a-z]+` and this value passed.
      { expressId: 1, type: 'IfcWall', name: 'aeiou' },
    ]);

    const spec: IDSSpecification = {
      id: 'spec-0',
      name: 'Consonants-only name pattern',
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
            value: patternConstraint('[a-z-[aeiou]]+'),
          },
          optionality: 'required',
        },
      ],
    };

    const report = await validateIDS(makeDoc([spec]), accessor, modelInfo);
    const result = report.specificationResults[0];

    // The core assertion: NOT a silent pass. A conformance validator
    // that approximated the pattern wrongly would report this
    // non-compliant value as compliant.
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    // Names the construct, so an author can rewrite the pattern rather
    // than guess — reuses the coherence auditor's wording for the same
    // construct (`audit/coherence/regex.ts`'s `checkPattern`).
    expect(result.error).toMatch(/XSD character-class subtraction is not supported in JS regex/);
    expect(report.summary.failedSpecifications).toBe(1);
    expect(report.summary.passedSpecifications).toBe(0);
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
