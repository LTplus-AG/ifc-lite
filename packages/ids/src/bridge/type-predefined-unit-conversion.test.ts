/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Predefined property sets and a type object's own property sets go
 * through the same base-SI conversion as instance property sets
 * (#7395, part 2).
 *
 * IDS literals for IFC measures are base SI. Instance and type-inherited
 * property sets were converted by the project's length/area/volume scale,
 * but two sources were surfaced raw:
 *   - predefined property sets (`IfcDoorPanelProperties.PanelDepth`, an
 *     `IfcPositiveLengthMeasure`), whose attribute types the schema gives;
 *   - a type object's own `HasPropertySets`, read when the IDS checks the
 *     type object itself.
 * In a millimetre project a 50 mm panel depth was compared as 50 m.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from './index.js';

// A millimetre project. Door #20 carries a door panel (#21: depth 50 mm,
// and a width that is a ratio, 0.5, not a length). Wall type #30 carries its own
// property set with a 250 mm width and a label.
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('','2026-10-11T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#20=IFCDOOR('0000000000000000000020',$,'D-1',$,$,$,$,$,$,$,$,$,$);
#21=IFCDOORPANELPROPERTIES('0000000000000000000021',$,'Panel',$,50.,.SWINGING.,0.5,.LEFT.,$);
#22=IFCRELDEFINESBYPROPERTIES('0000000000000000000022',$,$,$,(#20),#21);
#30=IFCWALLTYPE('0000000000000000000030',$,'WT-1',$,$,(#33),$,$,$,.STANDARD.);
#31=IFCPROPERTYSINGLEVALUE('Width',$,IFCPOSITIVELENGTHMEASURE(250.),$);
#32=IFCPROPERTYSINGLEVALUE('Finish',$,IFCLABEL('Paint'),$);
#33=IFCPROPERTYSET('0000000000000000000033',$,'Probe_TypeSet',$,(#31,#32));
ENDSEC;
END-ISO-10303-21;
`;

async function load() {
  const bytes = new TextEncoder().encode(IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer, { disableWorkerScan: true });
  return { store, accessor: createDataAccessor(store) };
}

describe('predefined and type-own property sets are converted to base SI (#7395)', () => {
  it('converts a predefined property set attribute that is a length measure', async () => {
    const { accessor } = await load();
    const depth = accessor.getPropertyValue(20, 'Panel', 'PanelDepth');
    expect(depth?.dataType).toBe('IFCPOSITIVELENGTHMEASURE');
    expect(depth?.value).toBeCloseTo(0.05, 12);
    // A ratio is not a length: it stays as written.
    expect(accessor.getPropertyValue(20, 'Panel', 'PanelWidth')?.value).toBe(0.5);
  });

  it("converts a type object's own property set when the type itself is checked", async () => {
    const { accessor } = await load();
    expect(accessor.getPropertyValue(30, 'Probe_TypeSet', 'Width')?.value).toBeCloseTo(0.25, 12);
    expect(accessor.getPropertyValue(30, 'Probe_TypeSet', 'Finish')?.value).toBe('Paint');
  });

  it('passes the issue reproduction end to end, from the IDS text', async () => {
    const { store, accessor } = await load();
    const doc = parseIDS(`<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>type and predefined sets</title></info>
  <specifications>
    <specification name="Wall types 0.25 m wide" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALLTYPE</simpleValue></name></entity></applicability>
      <requirements><property dataType="IFCPOSITIVELENGTHMEASURE"><propertySet><simpleValue>Probe_TypeSet</simpleValue></propertySet><baseName><simpleValue>Width</simpleValue></baseName><value><simpleValue>0.25</simpleValue></value></property></requirements>
    </specification>
    <specification name="Door panels 0.05 m deep" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCDOOR</simpleValue></name></entity></applicability>
      <requirements><property dataType="IFCPOSITIVELENGTHMEASURE"><propertySet><simpleValue>Panel</simpleValue></propertySet><baseName><simpleValue>PanelDepth</simpleValue></baseName><value><simpleValue>0.05</simpleValue></value></property></requirements>
    </specification>
  </specifications>
</ids>`);
    const report = await validateIDS(doc, accessor, {
      modelId: 'm',
      schemaVersion: store.schemaVersion,
      entityCount: store.entityCount,
    }, { includePassingEntities: true });
    expect(report.specificationResults.map((r) => [r.specification.name, r.entityResults.map((e) => e.passed)])).toEqual([
      ['Wall types 0.25 m wide', [true]],
      ['Door panels 0.05 m deep', [true]],
    ]);
  });
});
