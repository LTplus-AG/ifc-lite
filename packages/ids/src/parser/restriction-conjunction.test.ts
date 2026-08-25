/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * XSD facets declared in one `<xs:restriction>` are conjunctive. The
 * parser used to return the first family it recognised — pattern, then
 * enumeration, then bounds — and drop the rest, so the facets that
 * NARROW the constraint disappeared and out-of-range values passed.
 *
 * Each case here is asserted in both directions: a value the surviving
 * facet accepted but the dropped one rejects (the false PASS), and a
 * value both accept (so the fix cannot be a blanket reject).
 */

import { parseIDS } from './xml-parser.js';
import { matchConstraint, formatConstraint } from '../constraints/index.js';
import { createTranslationService } from '../translation/service.js';
import type { IDSConstraint, IDSPropertyFacet } from '../types.js';

function constraintFrom(restriction: string): IDSConstraint {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Conjunction</title></info>
  <specifications>
    <specification name="conjunction" ifcVersion="IFC4">
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
  const facet = parseIDS(xml).specifications[0]!.requirements[0]!
    .facet as IDSPropertyFacet;
  const value = facet.value;
  if (!value) throw new Error('restriction did not parse into a value constraint');
  return value;
}

/** The conjunctive facets riding along on the primary constraint. */
function siblingsOf(c: IDSConstraint): readonly IDSConstraint[] {
  return (c as { and?: readonly IDSConstraint[] }).and ?? [];
}

describe('an xs:restriction with several facets enforces all of them', () => {
  it('bounds are not dropped when a pattern is present', () => {
    const c = constraintFrom(
      `<xs:restriction base="xs:double">
         <xs:minInclusive value="10"/>
         <xs:maxInclusive value="20"/>
         <xs:pattern value="\\d+"/>
       </xs:restriction>`
    );
    // 999 is all digits, so the pattern alone accepted it.
    expect(matchConstraint(c, 999)).toBe(false);
    // …and a value inside the range still matches, both facets agreeing.
    expect(matchConstraint(c, 15)).toBe(true);
  });

  it('bounds are not dropped when an enumeration is present', () => {
    const c = constraintFrom(
      `<xs:restriction base="xs:double">
         <xs:maxInclusive value="20"/>
         <xs:enumeration value="5"/>
         <xs:enumeration value="99"/>
       </xs:restriction>`
    );
    expect(matchConstraint(c, 99)).toBe(false);
    expect(matchConstraint(c, 5)).toBe(true);
    // Anti-vacuity: not everything now fails — a value outside the
    // enumeration but inside the bound is still rejected by the
    // enumeration, i.e. both facets are live, not just the new one.
    expect(matchConstraint(c, 7)).toBe(false);
  });

  it('a length facet is not dropped when a pattern is present', () => {
    const c = constraintFrom(
      `<xs:restriction base="xs:string">
         <xs:maxLength value="3"/>
         <xs:pattern value="[A-Z]+"/>
       </xs:restriction>`
    );
    expect(matchConstraint(c, 'ABCDEFGHIJ')).toBe(false);
    expect(matchConstraint(c, 'ABC')).toBe(true);
    // Still rejected by the pattern, not by the length.
    expect(matchConstraint(c, 'abc')).toBe(false);
  });

  it('keeps a single-family restriction exactly as it was', () => {
    // Negative control: the common case must not grow an `and` list, so
    // the switches in audit/ and translation/ see an unchanged shape.
    const c = constraintFrom(
      `<xs:restriction base="xs:string">
         <xs:pattern value="[A-Z]+"/>
       </xs:restriction>`
    );
    expect(c.type).toBe('pattern');
    expect(siblingsOf(c)).toEqual([]);
    expect(matchConstraint(c, 'ABC')).toBe(true);
    expect(matchConstraint(c, 'abc')).toBe(false);
  });

  it('the primary constraint keeps the type the first family had', () => {
    // The facet checkers and the auditor switch on `type`; a combined
    // restriction must still present one they already handle.
    const c = constraintFrom(
      `<xs:restriction base="xs:double">
         <xs:minInclusive value="10"/>
         <xs:pattern value="\\d+"/>
       </xs:restriction>`
    );
    expect(c.type).toBe('pattern');
    expect(siblingsOf(c).map((s) => s.type)).toEqual(['bounds']);
    // `@base` survives onto the primary, which the auditor reads.
    if (c.type !== 'pattern') throw new Error('expected a pattern constraint');
    expect(c.base).toBe('xs:double');
  });

  it('describes every facet in the human-readable report text', () => {
    // `describeConstraint` feeds the viewer, the MCP tools and the SDK.
    // Naming only the primary would tell the reader a weaker requirement
    // than the one being enforced.
    const c = constraintFrom(
      `<xs:restriction base="xs:double">
         <xs:minInclusive value="10"/>
         <xs:maxInclusive value="20"/>
         <xs:pattern value="\\d+"/>
       </xs:restriction>`
    );
    const described = createTranslationService('en').describeConstraint(c);
    expect(described).toContain('pattern');
    expect(described).toContain('between 10 and 20');
    // A single-family restriction keeps its old wording, unjoined.
    const single = constraintFrom(
      `<xs:restriction base="xs:string"><xs:pattern value="[A-Z]+"/></xs:restriction>`
    );
    expect(createTranslationService('en').describeConstraint(single)).toBe(
      'matching pattern "[A-Z]+"'
    );
  });

  it('names every facet in the expected-value display', () => {
    // Reporting only the primary would state an expectation narrower
    // than the one enforced.
    const c = constraintFrom(
      `<xs:restriction base="xs:double">
         <xs:minInclusive value="10"/>
         <xs:maxInclusive value="20"/>
         <xs:pattern value="\\d+"/>
       </xs:restriction>`
    );
    const shown = formatConstraint(c);
    expect(shown).toContain('pattern');
    expect(shown).toContain('between 10 and 20');
  });
});
