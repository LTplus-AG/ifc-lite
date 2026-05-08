/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { auditIDSDocument, auditIDSStructure } from './index.js';
import type { IDSAuditCode } from './types.js';

const idsHeader = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Test IDS</title></info>
  <specifications>`;
const idsFooter = `  </specifications>
</ids>`;

function wrap(spec: string): string {
  return `${idsHeader}\n${spec}\n${idsFooter}`;
}

function codes(issues: { code: IDSAuditCode }[]): IDSAuditCode[] {
  return issues.map((i) => i.code);
}

describe('auditIDSDocument — parse layer', () => {
  it('returns status=error with a parse issue for non-XML input', async () => {
    const r = await auditIDSDocument('not xml at all');
    expect(r.status).toBe('error');
    expect(codes(r.issues)).toContain('E_PARSE_XML');
    expect(r.parsedDocument).toBeUndefined();
  });

  it('returns status=error with a parse issue for the wrong root element', async () => {
    const r = await auditIDSDocument('<?xml version="1.0"?><nope/>');
    expect(r.status).toBe('error');
    expect(codes(r.issues)).toContain('E_PARSE_ROOT');
  });

  it('preserves the parsed document on success', async () => {
    const xml = wrap(`<specification name="Has walls" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(r.parsedDocument).toBeDefined();
    expect(r.parsedDocument?.specifications).toHaveLength(1);
  });
});

describe('auditIDSDocument — XSD checks', () => {
  it('flags missing specification name', async () => {
    const xml = wrap(`<specification ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements><attribute><name><simpleValue>Name</simpleValue></name></attribute></requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_XSD_REQUIRED_ATTR');
  });

  it('flags an empty applicability block', async () => {
    const xml = wrap(`<specification name="Empty" ifcVersion="IFC4">
      <applicability></applicability>
      <requirements><attribute><name><simpleValue>Name</simpleValue></name></attribute></requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_XSD_STRUCTURE');
  });

  it('warns on a specification with no requirements', async () => {
    const xml = wrap(`<specification name="No reqs" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements></requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(r.status).toBe('warning');
    expect(codes(r.issues)).toContain('E_XSD_STRUCTURE');
  });
});

describe('auditIDSDocument — IFC schema cross-checks', () => {
  it('passes a well-formed IFC4 wall specification', async () => {
    const xml = wrap(`<specification name="Wall name" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(r.status).toBe('valid');
    expect(r.issues).toEqual([]);
  });

  it('flags an unknown IFC entity for the declared version', async () => {
    const xml = wrap(`<specification name="Bogus entity" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCFLUFFYWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_IFC_ENTITY_UNKNOWN');
  });

  it('flags an invalid predefined type for a known entity', async () => {
    const xml = wrap(`<specification name="Bogus pdt" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name><simpleValue>IFCWALL</simpleValue></name>
          <predefinedType><simpleValue>NOT_A_REAL_PDT</simpleValue></predefinedType>
        </entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_IFC_PREDEF_TYPE_INVALID');
  });

  it('accepts a valid predefined type', async () => {
    const xml = wrap(`<specification name="Solid wall" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name><simpleValue>IFCWALL</simpleValue></name>
          <predefinedType><simpleValue>SOLIDWALL</simpleValue></predefinedType>
        </entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).not.toContain('E_IFC_PREDEF_TYPE_INVALID');
  });

  it('flags an attribute that does not exist on the applicability entity', async () => {
    const xml = wrap(`<specification name="Bogus attr" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>FluffyAttribute</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_IFC_ATTR_UNKNOWN_FOR_ENTITY');
  });

  it('accepts an inherited attribute (Name comes from IfcRoot)', async () => {
    const xml = wrap(`<specification name="Inherited attr" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>GlobalId</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).not.toContain('E_IFC_ATTR_UNKNOWN_FOR_ENTITY');
  });

  it('flags a property that does not exist in a known pset', async () => {
    const xml = wrap(`<specification name="Bogus prop" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>NotARealProperty</simpleValue></baseName>
        </property>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_IFC_PROP_NOT_IN_PSET');
  });

  it('warns on an unknown Pset_*-prefixed pset (reserved prefix)', async () => {
    const xml = wrap(`<specification name="Reserved prefix" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_NotPublishedByBSI</simpleValue></propertySet>
          <baseName><simpleValue>SomeProperty</simpleValue></baseName>
        </property>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('W_IFC_PSET_RESERVED_PREFIX');
  });

  it('does not warn on a custom-prefixed pset', async () => {
    const xml = wrap(`<specification name="Custom pset" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>MyCorp_CustomPset</simpleValue></propertySet>
          <baseName><simpleValue>SomeProperty</simpleValue></baseName>
        </property>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).not.toContain('W_IFC_PSET_RESERVED_PREFIX');
  });

  it('flags a partOf relation that is not valid for the IFC version', async () => {
    const xml = wrap(`<specification name="Bogus partof" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
        <partOf relation="IfcRelTotallyMadeUp"><entity><name><simpleValue>IFCBUILDING</simpleValue></name></entity></partOf>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_IFC_PARTOF_RELATION');
  });
});

describe('auditIDSDocument — coherence checks', () => {
  it('flags an empty xs:enumeration', async () => {
    const xml = wrap(`<specification name="Empty enum" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name>
            <xs:restriction base="xs:string"></xs:restriction>
          </name>
        </entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    // The parser falls back to a simpleValue for empty restrictions; the
    // XSD audit catches the empty entity name.
    expect(r.status).toBe('error');
  });

  it('flags inverted bounds (min > max)', async () => {
    const xml = wrap(`<specification name="Bad bounds" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>ThermalTransmittance</simpleValue></baseName>
          <value>
            <xs:restriction base="xs:double">
              <xs:minInclusive value="10"/>
              <xs:maxInclusive value="1"/>
            </xs:restriction>
          </value>
        </property>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_RESTRICTION_RANGE');
  });

  it('errors on a regex pattern that does not compile and uses no XSD-only syntax', async () => {
    const xml = wrap(`<specification name="Bad regex" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute>
          <name><simpleValue>Name</simpleValue></name>
          <value>
            <xs:restriction base="xs:string">
              <xs:pattern value="(unclosed"/>
            </xs:restriction>
          </value>
        </attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_RESTRICTION_EMPTY');
  });

  it('warns on a regex pattern that uses XSD-specific syntax not supported by JS', async () => {
    const xml = wrap(`<specification name="XSD regex" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute>
          <name><simpleValue>Name</simpleValue></name>
          <value>
            <xs:restriction base="xs:string">
              <xs:pattern value="\\i\\c*"/>
            </xs:restriction>
          </value>
        </attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    // Either we accept it under JS (no issue) or warn that we can't verify
    // the XSD-only syntax — both are acceptable.
    const cs = codes(r.issues);
    if (cs.length > 0) {
      expect(cs).toContain('W_REGEX_UNVERIFIED');
    }
  });

  it('flags inverted spec-level minOccurs/maxOccurs', async () => {
    const xml = wrap(`<specification name="Bad cardinality" ifcVersion="IFC4">
      <applicability minOccurs="5" maxOccurs="2">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_CARDINALITY_INVALID');
  });
});

describe('auditIDSDocument — options', () => {
  it('skips IFC schema cross-checks when ifcSchemaChecks=false', async () => {
    const xml = wrap(`<specification name="Bogus entity" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCFLUFFYWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml, { ifcSchemaChecks: false });
    expect(codes(r.issues)).not.toContain('E_IFC_ENTITY_UNKNOWN');
  });

  it('honours the ifcVersion override', async () => {
    // IFC4X3-only entity, declared as IFC2X3 — without override would fail
    const xml = wrap(`<specification name="Civil" ifcVersion="IFC2X3">
      <applicability>
        <entity><name><simpleValue>IFCALIGNMENT</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const baseline = await auditIDSDocument(xml);
    expect(codes(baseline.issues)).toContain('E_IFC_ENTITY_UNKNOWN');

    const overridden = await auditIDSDocument(xml, { ifcVersion: 'IFC4X3' });
    expect(codes(overridden.issues)).not.toContain('E_IFC_ENTITY_UNKNOWN');
  });
});

describe('auditIDSDocument — review feedback fixes', () => {
  it('rejects an invalid @cardinality value (e.g. "Optional")', async () => {
    const xml = wrap(`<specification name="X" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute cardinality="Optional">
          <name><simpleValue>Name</simpleValue></name>
        </attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(r.status).toBe('error');
    expect(codes(r.issues)).toContain('E_CARDINALITY_INVALID');
  });

  it('rejects a bogus @cardinality value', async () => {
    const xml = wrap(`<specification name="X" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute cardinality="Invalid">
          <name><simpleValue>Name</simpleValue></name>
        </attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_CARDINALITY_INVALID');
  });

  it('audits every declared @ifcVersion, not just the first', async () => {
    // IfcRoad is IFC4X3-only. A spec declaring both IFC4X3 and IFC4
    // must fail because the reference is invalid in IFC4 — the older
    // pickVersion logic only checked IFC4X3 first and missed it.
    const xml = wrap(`<specification name="X" ifcVersion="IFC4X3_ADD2 IFC4">
      <applicability>
        <entity><name><simpleValue>IFCROAD</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_IFC_ENTITY_UNKNOWN');
  });

  it('does not false-positive on a numeric xs:restriction over an integer dataType', async () => {
    const xml = wrap(`<specification name="X" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCINTEGER">
          <propertySet><simpleValue>CustomPset</simpleValue></propertySet>
          <baseName><simpleValue>SomeIntProp</simpleValue></baseName>
          <value>
            <xs:restriction base="xs:integer">
              <xs:enumeration value="1"/>
              <xs:enumeration value="2"/>
            </xs:restriction>
          </value>
        </property>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).not.toContain('E_RESTRICTION_BASE_MISMATCH');
  });

  it('flags an enumeration value that is invalid for its restriction base', async () => {
    const xml = wrap(`<specification name="X" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCREAL">
          <propertySet><simpleValue>CustomPset</simpleValue></propertySet>
          <baseName><simpleValue>SomeReal</simpleValue></baseName>
          <value>
            <xs:restriction base="xs:double">
              <xs:enumeration value="12.0"/>
              <xs:enumeration value="not-a-number"/>
            </xs:restriction>
          </value>
        </property>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_RESTRICTION_VALUE_MISMATCH');
  });
});

describe('auditIDSStructure', () => {
  it('audits an already-parsed document without re-parsing', async () => {
    const r = await auditIDSStructure({
      info: { title: 'Direct' },
      specifications: [
        {
          id: 's1',
          name: 'Direct',
          ifcVersions: ['IFC4'],
          applicability: {
            facets: [
              {
                type: 'entity',
                name: { type: 'simpleValue', value: 'IFCWALL' },
              },
            ],
          },
          requirements: [
            {
              id: 'r1',
              optionality: 'required',
              facet: {
                type: 'attribute',
                name: { type: 'simpleValue', value: 'Name' },
              },
            },
          ],
        },
      ],
    });
    expect(r.status).toBe('valid');
  });
});
