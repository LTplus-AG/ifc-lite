/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseIDS, IDSParseError } from './xml-parser.js';
import { matchConstraint } from '../constraints/index.js';
import type { IDSBoundsConstraint } from '../types.js';

// ============================================================================
// Valid IDS XML Parsing
// ============================================================================

describe('parseIDS — valid documents', () => {
  it('parses a minimal valid IDS document', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info>
    <title>Test IDS</title>
  </info>
  <specifications>
    <specification name="Walls must have a name" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name><simpleValue>IFCWALL</simpleValue></name>
        </entity>
      </applicability>
      <requirements>
        <attribute>
          <name><simpleValue>Name</simpleValue></name>
        </attribute>
      </requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);

    expect(doc.info.title).toBe('Test IDS');
    expect(doc.specifications).toHaveLength(1);
    expect(doc.specifications[0].name).toBe('Walls must have a name');
    expect(doc.specifications[0].ifcVersions).toEqual(['IFC4']);
    expect(doc.specifications[0].applicability.facets).toHaveLength(1);
    expect(doc.specifications[0].applicability.facets[0].type).toBe('entity');
    expect(doc.specifications[0].requirements).toHaveLength(1);
    expect(doc.specifications[0].requirements[0].facet.type).toBe('attribute');
    expect(doc.specifications[0].requirements[0].optionality).toBe('required');
  });

  it('parses info section fields', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info>
    <title>My IDS</title>
    <copyright>Copyright 2024</copyright>
    <version>1.0</version>
    <author>Test Author</author>
    <date>2024-01-01</date>
    <purpose>Testing</purpose>
    <milestone>Design</milestone>
    <description>A test document</description>
  </info>
  <specifications></specifications>
</ids>`;

    const doc = parseIDS(xml);
    expect(doc.info.title).toBe('My IDS');
    expect(doc.info.copyright).toBe('Copyright 2024');
    expect(doc.info.version).toBe('1.0');
    expect(doc.info.author).toBe('Test Author');
    expect(doc.info.date).toBe('2024-01-01');
    expect(doc.info.purpose).toBe('Testing');
    expect(doc.info.milestone).toBe('Design');
    expect(doc.info.description).toBe('A test document');
  });

  it('parses IFC version strings', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Test</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements></requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    expect(doc.specifications[0].ifcVersions).toEqual([
      'IFC2X3',
      'IFC4',
      'IFC4X3',
    ]);
  });

  it('defaults to IFC4 when version is unrecognized', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="INVALID_VERSION">
      <applicability></applicability>
      <requirements></requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    expect(doc.specifications[0].ifcVersions).toEqual(['IFC4']);
  });

  it('parses minOccurs and maxOccurs', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4" minOccurs="1" maxOccurs="10">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements></requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    expect(doc.specifications[0].minOccurs).toBe(1);
    expect(doc.specifications[0].maxOccurs).toBe(10);
  });

  it('parses maxOccurs="unbounded"', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4" maxOccurs="unbounded">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements></requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    expect(doc.specifications[0].maxOccurs).toBe('unbounded');
  });

  it('parses minOccurs="0" correctly (falsy but valid)', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4" minOccurs="0" maxOccurs="0">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements></requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    expect(doc.specifications[0].minOccurs).toBe(0);
    expect(doc.specifications[0].maxOccurs).toBe(0);
  });

  it('parses requirement optionality from minOccurs/maxOccurs', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute minOccurs="0" maxOccurs="0">
          <name><simpleValue>Description</simpleValue></name>
        </attribute>
        <attribute minOccurs="0">
          <name><simpleValue>Tag</simpleValue></name>
        </attribute>
        <attribute>
          <name><simpleValue>Name</simpleValue></name>
        </attribute>
      </requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    const reqs = doc.specifications[0].requirements;
    expect(reqs).toHaveLength(3);
    expect(reqs[0].optionality).toBe('prohibited');
    expect(reqs[1].optionality).toBe('optional');
    expect(reqs[2].optionality).toBe('required');
  });

  it('parses property facet with all fields', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>FireRating</simpleValue></baseName>
          <dataType><simpleValue>IFCLABEL</simpleValue></dataType>
          <value><simpleValue>REI60</simpleValue></value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    const facet = doc.specifications[0].requirements[0].facet;
    expect(facet.type).toBe('property');
    if (facet.type === 'property') {
      expect(facet.propertySet).toEqual({ type: 'simpleValue', value: 'Pset_WallCommon' });
      expect(facet.baseName).toEqual({ type: 'simpleValue', value: 'FireRating' });
      expect(facet.dataType).toEqual({ type: 'simpleValue', value: 'IFCLABEL' });
      expect(facet.value).toEqual({ type: 'simpleValue', value: 'REI60' });
    }
  });

  it('parses classification facet', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <classification>
          <system><simpleValue>Uniclass</simpleValue></system>
          <value><simpleValue>EF_25_10</simpleValue></value>
        </classification>
      </requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    const facet = doc.specifications[0].requirements[0].facet;
    expect(facet.type).toBe('classification');
    if (facet.type === 'classification') {
      expect(facet.system).toEqual({ type: 'simpleValue', value: 'Uniclass' });
      expect(facet.value).toEqual({ type: 'simpleValue', value: 'EF_25_10' });
    }
  });

  it('parses material facet', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <material>
          <value><simpleValue>Concrete</simpleValue></value>
        </material>
      </requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    const facet = doc.specifications[0].requirements[0].facet;
    expect(facet.type).toBe('material');
    if (facet.type === 'material') {
      expect(facet.value).toEqual({ type: 'simpleValue', value: 'Concrete' });
    }
  });

  it('parses partOf facet with entity constraint', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <partOf relation="IfcRelAggregates">
          <entity>
            <name><simpleValue>IfcBuildingStorey</simpleValue></name>
          </entity>
        </partOf>
      </requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    const facet = doc.specifications[0].requirements[0].facet;
    expect(facet.type).toBe('partOf');
    if (facet.type === 'partOf') {
      expect(facet.relation).toBe('IfcRelAggregates');
      expect(facet.entity?.name).toEqual({
        type: 'simpleValue',
        value: 'IfcBuildingStorey',
      });
    }
  });

  it('parses the merged voids/fills partOf relation without collapsing it (issue #1205)', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWINDOW</simpleValue></name></entity>
      </applicability>
      <requirements>
        <partOf relation="IFCRELVOIDSELEMENT IFCRELFILLSELEMENT">
          <entity>
            <name><simpleValue>IFCWALL</simpleValue></name>
          </entity>
        </partOf>
      </requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    const facet = doc.specifications[0].requirements[0].facet;
    expect(facet.type).toBe('partOf');
    if (facet.type === 'partOf') {
      // Must NOT be collapsed to 'IfcRelVoidsElement' (the old bug).
      expect(facet.relation).toBe('IfcRelVoidsElement IfcRelFillsElement');
    }
  });

  it('parses XSD restriction with pattern', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name>
            <xs:restriction>
              <xs:pattern value="IFC.*WALL"/>
            </xs:restriction>
          </name>
        </entity>
      </applicability>
      <requirements></requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    const entityFacet = doc.specifications[0].applicability.facets[0];
    expect(entityFacet.type).toBe('entity');
    if (entityFacet.type === 'entity') {
      expect(entityFacet.name).toEqual({ type: 'pattern', pattern: 'IFC.*WALL' });
    }
  });

  it('parses XSD restriction with enumeration', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name>
            <xs:restriction>
              <xs:enumeration value="IFCWALL"/>
              <xs:enumeration value="IFCSLAB"/>
            </xs:restriction>
          </name>
        </entity>
      </applicability>
      <requirements></requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    const entityFacet = doc.specifications[0].applicability.facets[0];
    if (entityFacet.type === 'entity') {
      expect(entityFacet.name).toEqual({
        type: 'enumeration',
        values: ['IFCWALL', 'IFCSLAB'],
      });
    }
  });

  it('parses XSD restriction with bounds', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>ThermalTransmittance</simpleValue></baseName>
          <value>
            <xs:restriction>
              <xs:minInclusive value="0"/>
              <xs:maxInclusive value="1.5"/>
            </xs:restriction>
          </value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    const facet = doc.specifications[0].requirements[0].facet;
    if (facet.type === 'property') {
      expect(facet.value).toEqual({
        type: 'bounds',
        minInclusive: 0,
        maxInclusive: 1.5,
      });
    }
  });

  it('parses XSD restriction with totalDigits/fractionDigits (a standalone digit facet used to fall through to an empty enumeration, which fails every value)', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>ThermalTransmittance</simpleValue></baseName>
          <value>
            <xs:restriction base="xs:decimal">
              <xs:fractionDigits value="2"/>
            </xs:restriction>
          </value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;

    const doc = parseIDS(xml);
    const facet = doc.specifications[0].requirements[0].facet;
    if (facet.type === 'property') {
      expect(facet.value).toEqual({
        type: 'bounds',
        base: 'xs:decimal',
        fractionDigits: 2,
      });
    }
  });

  it('handles ArrayBuffer input', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Buffer Test</title></info>
  <specifications></specifications>
</ids>`;
    const buffer = new TextEncoder().encode(xml).buffer;
    const doc = parseIDS(buffer);
    expect(doc.info.title).toBe('Buffer Test');
  });
});

// ============================================================================
// Error Handling
// ============================================================================

describe('parseIDS — error handling', () => {
  it('throws IDSParseError for invalid XML', () => {
    expect(() => parseIDS('<not-closed')).toThrow(IDSParseError);
  });

  it('throws IDSParseError when root element is not "ids"', () => {
    const xml = `<?xml version="1.0"?><wrongRoot></wrongRoot>`;
    expect(() => parseIDS(xml)).toThrow(IDSParseError);
    expect(() => parseIDS(xml)).toThrow(/expected "ids"/);
  });

  it('throws IDSParseError when entity facet lacks name element', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity></entity>
      </applicability>
      <requirements></requirements>
    </specification>
  </specifications>
</ids>`;
    expect(() => parseIDS(xml)).toThrow(IDSParseError);
    expect(() => parseIDS(xml)).toThrow(/Entity facet must have a name/);
  });

  it('throws IDSParseError when attribute facet lacks name element', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute></attribute>
      </requirements>
    </specification>
  </specifications>
</ids>`;
    expect(() => parseIDS(xml)).toThrow(/Attribute facet must have a name/);
  });

  it('throws IDSParseError when property facet lacks propertySet', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <baseName><simpleValue>Test</simpleValue></baseName>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;
    expect(() => parseIDS(xml)).toThrow(/Property facet must have a propertySet/);
  });

  it('throws IDSParseError when property facet lacks baseName', () => {
    const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Test</simpleValue></propertySet>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;
    expect(() => parseIDS(xml)).toThrow(/Property facet must have a baseName/);
  });
});

// ============================================================================
// xs:pattern ReDoS guard
//
// `(a+)+b` is the textbook catastrophic-backtracking shape: compiled and
// anchored as `^(?:(a+)+b)$` (constraints/match-family.ts's
// `buildPatternRegex`), testing it against `'a'.repeat(30)` measured ~4s
// on this machine — exponential in the subject length, synchronous,
// main-thread. A malformed spec must fail loudly at parse time, before
// any entity's property value is ever checked against it.
// ============================================================================

describe('parseIDS — xs:pattern ReDoS guard', () => {
  function idsWithPattern(pattern: string): string {
    return `<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>T</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_Test</simpleValue></propertySet>
          <baseName><simpleValue>Test</simpleValue></baseName>
          <value>
            <xs:restriction base="xs:string">
              <xs:pattern value="${pattern}"/>
            </xs:restriction>
          </value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;
  }

  it('rejects a catastrophic-backtracking pattern as a named, actionable IDSParseError — not a silent no-match', () => {
    const xml = idsWithPattern('(a+)+b');
    // The rejection is a thrown, actionable authoring error — not a
    // boolean the caller could mistake for "this spec is fine, it just
    // doesn't match anything" (which is what a silent `false` return
    // would look like at every call site downstream).
    expect(() => parseIDS(xml)).toThrow(IDSParseError);
    expect(() => parseIDS(xml)).toThrow(/catastrophic-backtracking/);
    // Names the offending pattern so the author can find and fix it.
    try {
      parseIDS(xml);
      throw new Error('expected parseIDS to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IDSParseError);
      const parseErr = err as IDSParseError;
      expect(parseErr.details).toContain('(a+)+b');
    }
  });

  it('rejects the catastrophic pattern immediately — the guard fires before any matching is attempted', () => {
    const xml = idsWithPattern('(a+)+b');
    const start = performance.now();
    expect(() => parseIDS(xml)).toThrow(IDSParseError);
    const elapsedMs = performance.now() - start;
    // A guard that let this pattern through to a real match attempt
    // against a moderately long value would cost seconds (measured
    // ~4000ms at a 30-character subject on this machine); rejecting it
    // at parse time is a length/shape check with no such cost.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('rejects an overlength pattern (over the 256-char cap) as a named IDSParseError', () => {
    const longPattern = `${'(a|b)'.repeat(52)}`; // 260 chars, no catastrophic shape — the length cap alone must catch it
    expect(longPattern.length).toBeGreaterThan(256);
    const xml = idsWithPattern(longPattern);
    expect(() => parseIDS(xml)).toThrow(IDSParseError);
    expect(() => parseIDS(xml)).toThrow(/256-character limit/);
  });

  it('still parses and matches a benign pattern with a quantified alternation (no catastrophic shape)', () => {
    const xml = idsWithPattern('(A|B)+');
    const doc = parseIDS(xml);
    const constraint = doc.specifications[0].requirements[0];
    expect(constraint).toBeDefined();
    // The whole point of a shape (not a blanket "no groups") heuristic:
    // ordinary quantified alternation is unaffected.
    const facet = doc.specifications[0].requirements[0].facet;
    if (facet.type === 'property' && facet.value) {
      expect(matchConstraint(facet.value, 'ABAB')).toBe(true);
      expect(matchConstraint(facet.value, 'C')).toBe(false);
    } else {
      throw new Error('expected a property facet with a value constraint');
    }
  });
});

// ============================================================================
// Parser -> matcher wiring for the string-length facets (#2746 follow-up)
// ============================================================================

/**
 * `constraints.test.ts` pins `matchBounds` against `IDSBoundsConstraint`
 * objects built by hand, so it cannot see the parser at all. Measured: making
 * the parser drop all three length facets
 *
 *   bounds.length    = readInt(facetEls.length)    -> undefined
 *   bounds.minLength = readInt(facetEls.minLength) -> undefined
 *   bounds.maxLength = readInt(facetEls.maxLength) -> undefined
 *
 * left the whole packages/ids suite green at 322/322. In user terms an IDS
 * author writes `<xs:maxLength value="8"/>`, the restriction is silently
 * dropped, and every element PASSES: a rule that stops restricting reports
 * success. These cases assert the extracted facets and then drive the matcher
 * with them, so the parse-to-match path has to survive as a whole.
 */
describe('parseIDS: xs:length / xs:minLength / xs:maxLength reach the matcher', () => {
  const idsWith = (facets: string): string => `<ids xmlns="http://standards.buildingsmart.org/IDS"
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
${facets}
            </xs:restriction>
          </value>
        </attribute>
      </requirements>
    </specification>
  </specifications>
</ids>`;

  /** Asserts the facet type rather than guarding on it: a conditional would
   *  skip its assertions silently if the shape ever changed. */
  const boundsOf = (xml: string): IDSBoundsConstraint => {
    const facet = parseIDS(xml).specifications[0].requirements[0].facet;
    expect(facet.type).toBe('attribute');
    const value = (facet as { value?: unknown }).value as IDSBoundsConstraint;
    expect(value.type).toBe('bounds');
    return value;
  };

  it('carries xs:length through the parser and enforces it in the matcher', () => {
    const bounds = boundsOf(idsWith('              <xs:length value="5"/>'));
    expect(bounds.length).toBe(5);

    expect(matchConstraint(bounds, 'abcde')).toBe(true);
    expect(matchConstraint(bounds, 'abcd')).toBe(false);
    expect(matchConstraint(bounds, 'abcdef')).toBe(false);
  });

  it('carries xs:minLength through the parser and enforces it in the matcher', () => {
    const bounds = boundsOf(idsWith('              <xs:minLength value="3"/>'));
    expect(bounds.minLength).toBe(3);

    expect(matchConstraint(bounds, 'abc')).toBe(true);
    expect(matchConstraint(bounds, 'ab')).toBe(false);
  });

  it('carries xs:maxLength through the parser and enforces it in the matcher', () => {
    const bounds = boundsOf(idsWith('              <xs:maxLength value="8"/>'));
    expect(bounds.maxLength).toBe(8);

    expect(matchConstraint(bounds, 'abcdefgh')).toBe(true);
    expect(matchConstraint(bounds, 'abcdefghi')).toBe(false);
  });

  it('carries a combined minLength/maxLength range', () => {
    const bounds = boundsOf(idsWith('              <xs:minLength value="2"/>\n              <xs:maxLength value="4"/>'));
    expect(bounds.minLength).toBe(2);
    expect(bounds.maxLength).toBe(4);

    expect(matchConstraint(bounds, 'ab')).toBe(true);
    expect(matchConstraint(bounds, 'abcd')).toBe(true);
    expect(matchConstraint(bounds, 'a')).toBe(false);
    expect(matchConstraint(bounds, 'abcde')).toBe(false);
  });
});
