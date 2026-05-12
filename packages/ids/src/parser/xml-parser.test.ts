/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseIDS, IDSParseError } from './xml-parser.js';

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
