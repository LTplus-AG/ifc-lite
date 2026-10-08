/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-010: the facets of one `<xs:restriction>` are conjunctive, and the
 * parser keeps every family after the first as an `and` sibling. Each
 * fixture below puts the defect ONLY in a sibling (the primary family is
 * well-formed), so it is caught only if the audit visits siblings.
 */

import { describe, expect, it } from 'vitest';
import { auditIDSDocument } from '../index.js';

function ids(value: string, facet = 'attribute', nameTag = 'name', name = 'Name'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Conjunctions</title></info>
  <specifications>
    <specification name="S" ifcVersion="IFC4">
      <applicability minOccurs="1" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <${facet} cardinality="required"><${nameTag}><simpleValue>${name}</simpleValue></${nameTag}><value>${value}</value></${facet}>
      </requirements>
    </specification>
  </specifications>
</ids>`;
}

async function errorsAt(xml: string): Promise<Array<{ code: string; path?: string }>> {
  const report = await auditIDSDocument(xml);
  return report.issues.filter((i) => i.severity === 'error').map(({ code, path }) => ({ code, path }));
}

describe('audit inspects conjunctive restriction siblings (IDS-010)', () => {
  it('a well-formed conjunction is clean', async () => {
    const xml = ids('<xs:restriction base="xs:string"><xs:pattern value="[A-Z]+"/><xs:minLength value="1"/><xs:maxLength value="4"/></xs:restriction>');
    expect(await errorsAt(xml)).toEqual([]);
  });

  it('flags an inverted length range in the bounds sibling of a pattern', async () => {
    const xml = ids('<xs:restriction base="xs:string"><xs:pattern value="[A-Z]+"/><xs:minLength value="9"/><xs:maxLength value="4"/></xs:restriction>');
    expect(await errorsAt(xml)).toContainEqual({ code: 'E_RESTRICTION_RANGE', path: 'specifications[0].requirements[0].value.and[0]' });
  });

  it('flags an inverted numeric bound in the bounds sibling of an enumeration', async () => {
    const xml = ids('<xs:restriction base="xs:double"><xs:enumeration value="1"/><xs:minInclusive value="5"/><xs:maxInclusive value="2"/></xs:restriction>');
    expect(await errorsAt(xml)).toContainEqual({ code: 'E_RESTRICTION_RANGE', path: 'specifications[0].requirements[0].value.and[0]' });
  });

  it('flags a bad enumeration value in the enumeration sibling of a pattern', async () => {
    const xml = ids('<xs:restriction base="xs:double"><xs:pattern value="[0-9]+"/><xs:enumeration value="12,0"/></xs:restriction>');
    expect(await errorsAt(xml)).toContainEqual({ code: 'E_RESTRICTION_VALUE_MISMATCH', path: 'specifications[0].requirements[0].value.and[0]' });
  });

  it('flags an unparseable bound in a sibling', async () => {
    const xml = ids('<xs:restriction base="xs:double"><xs:enumeration value="1"/><xs:maxInclusive value="six"/></xs:restriction>');
    expect(await errorsAt(xml)).toContainEqual({ code: 'E_RESTRICTION_FACET_UNPARSEABLE', path: 'specifications[0].requirements[0].value.and[0]' });
  });

  it('a digits-only bounds restriction is not reported as empty', async () => {
    const xml = ids('<xs:restriction base="xs:decimal"><xs:totalDigits value="5"/><xs:fractionDigits value="2"/></xs:restriction>');
    expect((await errorsAt(xml)).map((e) => e.code)).not.toContain('E_RESTRICTION_EMPTY');
  });
});
