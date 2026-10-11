/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-006: an attribute `<value>` is checked against the attribute's own
 * XSD type. The negative cases are the buildingSMART corpus `invalid-`
 * files (see `corpus.test.ts`); these pin the boundary from the valid side
 * and the attribute-specific paths.
 */

import { describe, expect, it } from 'vitest';
import { auditIDSDocument } from '../index.js';

function ids(entity: string, name: string, value: string, version = 'IFC4'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Attribute values</title></info>
  <specifications>
    <specification name="S" ifcVersion="${version}">
      <applicability minOccurs="1" maxOccurs="unbounded"><entity><name><simpleValue>${entity}</simpleValue></name></entity></applicability>
      <requirements><attribute cardinality="required"><name>${name}</name><value>${value}</value></attribute></requirements>
    </specification>
  </specifications>
</ids>`;
}

const sv = (v: string) => `<simpleValue>${v}</simpleValue>`;

async function errors(xml: string): Promise<string[]> {
  return (await auditIDSDocument(xml)).issues.filter((i) => i.severity === 'error').map((i) => `${i.code} ${i.path}`);
}

describe('attribute values match the attribute type (IDS-006)', () => {
  it('accepts literals of the attribute type', async () => {
    expect(await errors(ids('IFCTASK', sv('IsMilestone'), sv('false')))).toEqual([]);
    expect(await errors(ids('IFCSTAIRFLIGHT', sv('NumberOfRisers'), sv('42')))).toEqual([]);
    expect(await errors(ids('IFCSURFACESTYLEREFRACTION', sv('RefractionIndex'), sv('1.33')))).toEqual([]);
    expect(await errors(ids('IFCWALL', sv('Name'), '<xs:restriction base="xs:string"><xs:pattern value="W-.*"/></xs:restriction>'))).toEqual([]);
  });

  it('flags a value that is no literal of the attribute type, including through a name pattern', async () => {
    expect(await errors(ids('IFCTASK', sv('IsMilestone'), sv('TRUE'))))
      .toEqual(['E_RESTRICTION_VALUE_MISMATCH specifications[0].requirements[0].value']);
    const viaPattern = ids('IFCSTAIRFLIGHT', '<xs:restriction base="xs:string"><xs:pattern value="NumberOf(Risers|Treads)"/></xs:restriction>', sv('3.5'));
    expect(await errors(viaPattern)).toEqual(['E_RESTRICTION_VALUE_MISMATCH specifications[0].requirements[0].value']);
  });

  it('flags a restriction whose base is incompatible with the attribute type', async () => {
    const xml = ids('IFCSTAIRFLIGHT', sv('NumberOfRisers'), '<xs:restriction base="xs:string"><xs:enumeration value="12"/></xs:restriction>');
    expect(await errors(xml)).toEqual(['E_RESTRICTION_BASE_MISMATCH specifications[0].requirements[0].value']);
  });
});
