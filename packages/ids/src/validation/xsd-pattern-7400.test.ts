/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end regression for #7400: four valid XML Schema patterns gave the
 * wrong result. Two passed every value (a negated escape inside a class and
 * a `\p{Is…}` block escape were replaced by an any-character placeholder)
 * and two failed every value (`\-` is an invalid identity escape under the
 * JS `u` flag, and `$` was kept as a JS anchor although XSD regex has no
 * anchors). The expected column is what an XML Schema processor gives for
 * the four wall names from the issue.
 */

import { describe, expect, it } from 'vitest';

import { validateIDS } from './validator.js';
import { auditIDSDocument } from '../audit/index.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import type { IDSDocument, IDSModelInfo, IDSSimpleValue, IDSSpecification } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

const modelInfo: IDSModelInfo = { modelId: 'issue-7400', schemaVersion: 'IFC4', entityCount: 4 };

const NAMES = ['abc', 'ā', 'abc-1', 'US'] as const;

const accessor = createMockAccessor(
  NAMES.map((name, i) => ({ expressId: i + 1, type: 'IfcWall', name })),
);

function namePatternSpec(pattern: string): IDSSpecification {
  return {
    id: 'spec-0',
    name: pattern,
    ifcVersions: ['IFC4'],
    applicability: { facets: [{ type: 'entity', name: sv('IFCWALL') }] },
    requirements: [
      {
        id: 'req-0',
        facet: {
          type: 'attribute',
          name: sv('Name'),
          value: { type: 'pattern', pattern, base: 'string' },
        },
        optionality: 'required',
      },
    ],
  };
}

/** Pattern -> names that pass under XML Schema, from the issue's table. */
const CASES: ReadonlyArray<[string, readonly string[]]> = [
  ['[\\W]+', []],
  ['\\p{IsBasicLatin}+', ['abc', 'abc-1', 'US']],
  ['\\p{L}+\\-1', ['abc-1']],
  ['US$?', ['US']],
];

describe('validateIDS — XSD patterns from #7400', () => {
  for (const [pattern, passing] of CASES) {
    it(`${pattern} passes exactly ${passing.length ? passing.join(', ') : 'no value'}`, async () => {
      const doc: IDSDocument = { info: { title: 'issue-7400' }, specifications: [namePatternSpec(pattern)] };
      const report = await validateIDS(doc, accessor, modelInfo, { includePassingEntities: true });
      const result = report.specificationResults[0];

      expect(result.error).toBeUndefined();
      expect(result.applicableCount).toBe(NAMES.length);
      const passed = result.entityResults.filter((e) => e.passed).map((e) => e.entityName);
      expect(passed).toEqual(passing);
    });
  }
});

function idsWithNamePattern(pattern: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>issue-7400</title></info>
  <specifications>
    <specification name="p" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute>
          <name><simpleValue>Name</simpleValue></name>
          <value><xs:restriction base="xs:string"><xs:pattern value="${pattern}"/></xs:restriction></value>
        </attribute>
      </requirements>
    </specification>
  </specifications>
</ids>`;
}

describe('auditIDSDocument — XSD patterns from #7400', () => {
  for (const [pattern] of CASES) {
    it(`${pattern} is a valid, verifiable pattern (no warning, no error)`, async () => {
      const r = await auditIDSDocument(idsWithNamePattern(pattern));
      const regexIssues = r.issues.filter(
        (i) => i.code === 'W_REGEX_UNVERIFIED' || i.code === 'E_RESTRICTION_EMPTY',
      );
      expect(regexIssues).toEqual([]);
    });
  }

  it('an unknown block name still gets a diagnostic naming it, and validation refuses it', async () => {
    const pattern = '\\p{IsNoSuchBlock}+';
    const r = await auditIDSDocument(idsWithNamePattern(pattern));
    const warning = r.issues.find((i) => i.code === 'W_REGEX_UNVERIFIED');
    expect(warning?.message).toMatch(/IsNoSuchBlock/);

    const doc: IDSDocument = { info: { title: 'issue-7400' }, specifications: [namePatternSpec(pattern)] };
    const result = (await validateIDS(doc, accessor, modelInfo)).specificationResults[0];
    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/IsNoSuchBlock/);
  });
});
