/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adversarial review of #6153 found that `parseRestriction`'s
 * direct-text-content fallback (no recognised pattern/enumeration/bounds
 * child) still trimmed: `<xs:restriction base="xs:string"> Foo </xs:restriction>`
 * parsed to `'Foo'` instead of `' Foo '`. `xs:string` keeps whitespace —
 * the same rule `xml-parser.ts`'s `<simpleValue>` reading already
 * follows for #6117. This pins the untrimmed value and that a genuinely
 * empty (or pretty-printed, whitespace-only) restriction still surfaces
 * the empty-enumeration shape the coherence auditor expects.
 */

import { parseIDS } from './xml-parser.js';
import type { IDSConstraint, IDSPropertyFacet } from '../types.js';

function valueConstraintFrom(restriction: string): IDSConstraint {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Restriction text</title></info>
  <specifications>
    <specification name="restriction text" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_Custom</simpleValue></propertySet>
          <baseName><simpleValue>P</simpleValue></baseName>
          <value>${restriction}</value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;
  const facet = parseIDS(xml).specifications[0]!.requirements[0]!.facet as IDSPropertyFacet;
  const value = facet.value;
  if (!value) throw new Error('restriction did not parse into a value constraint');
  return value;
}

describe('parseRestriction direct-text fallback keeps xs:string whitespace verbatim (#6153 review)', () => {
  it('leading/trailing space around the restriction text is preserved', () => {
    const c = valueConstraintFrom('<xs:restriction base="xs:string"> Foo </xs:restriction>');
    expect(c).toEqual({ type: 'simpleValue', value: ' Foo ' });
  });

  it('a genuinely empty restriction (base attribute only, no text) still surfaces as an empty enumeration', () => {
    const c = valueConstraintFrom('<xs:restriction base="xs:string"/>');
    expect(c).toEqual({ type: 'enumeration', values: [], base: 'xs:string' });
  });

  it('a pretty-printed empty restriction (only indentation whitespace, no facet children) still surfaces as an empty enumeration — indentation whitespace must not masquerade as an authored value', () => {
    const c = valueConstraintFrom('<xs:restriction base="xs:string">\n            </xs:restriction>');
    expect(c).toEqual({ type: 'enumeration', values: [], base: 'xs:string' });
  });
});
