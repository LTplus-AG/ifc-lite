/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A type object keeps its quantity sets in the same `HasPropertySets` list as
 * its property sets (`SET OF IfcPropertySetDefinition`), and IDS treats a
 * quantity set as a property set. The bridge read only the type's
 * `IfcPropertySet`s (#ISSUE), so a `Qto_WallBaseQuantities` requirement met
 * only by the `IfcWallType` failed on its walls and on the type itself, and a
 * property applicability on it selected only walls with their own set.
 *
 * The model combines two buildingSMART cases,
 * property/pass-properties_can_be_inherited_from_the_type_1_2 and
 * property/pass-a_name_check_will_match_any_quantity_with_any_value.
 * IfcTester 0.8.4 on the same model: W1, W2 and WT pass, W3 fails (own Length 7),
 * and the applicability selects all three walls, in IFC2X3, IFC4 and IFC4X3.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { checkPropertyFacet } from '../facets/property-facet.js';
import { parseIDS } from '../parser/xml-parser.js';
import type { IDSPropertyFacet, IDSSimpleValue, IFCDataAccessor } from '../types.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from './data-accessor.js';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3_ADD2';
const SCHEMAS: Schema[] = ['IFC2X3', 'IFC4', 'IFC4X3_ADD2'];
const W1 = 20; // typed, no own sets
const W2 = 21; // typed, own Qto_WallBaseQuantities with Width only
const W3 = 22; // typed, own Qto_WallBaseQuantities with Length 7
const WT = 50;

interface Fixture {
  schema?: Schema;
  /** The project's length unit, `IFCSIUNIT(*,.LENGTHUNIT.,<this>)`. */
  lengthUnit?: string;
  /** The type's Length quantity: its value and its own Unit reference. */
  typeLength?: { value: string; unit?: string };
  /** More entries for the type's HasPropertySets, and their lines. */
  typeSets?: { ids: number[]; lines: string[] };
}

function model({ schema = 'IFC4', lengthUnit = '$,.METRE.', typeLength = { value: '5.' }, typeSets }: Fixture = {}): string {
  const ifc2x3 = schema === 'IFC2X3';
  const gid = (prefix: string, id: number) => prefix + String(id).padStart(22 - prefix.length, '0');
  // IFC2X3 IfcWall has no PredefinedType and IfcQuantityLength no Formula.
  const tail = ifc2x3 ? '' : ',$';
  const wall = (id: number, name: string) => `#${id}=IFCWALL('${gid('0wall', id)}',$,'${name}',$,$,$,$,$${tail});`;
  const length = (id: number, name: string, value: string, unit = '$') =>
    `#${id}=IFCQUANTITYLENGTH('${name}',$,${unit},${value}${tail});`;
  const qset = (id: number, member: number) =>
    `#${id}=IFCELEMENTQUANTITY('${gid('0qto', id)}',$,'Qto_WallBaseQuantities',$,$,(#${member}));`;
  const own = (rel: number, wallId: number, setId: number) =>
    `#${rel}=IFCRELDEFINESBYPROPERTIES('${gid('0rdbp', rel)}',$,$,$,(#${wallId}),#${setId});`;
  const hasSets = [51, 53, ...(typeSets?.ids ?? [])].map((id) => `#${id}`).join(',');
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('type-qto.ifc','2026-10-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('${gid('0proj', 1)}',$,'P',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,${lengthUnit});
#3=IFCUNITASSIGNMENT((#2));
#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
${wall(W1, 'W1')}
${wall(W2, 'W2')}
${wall(W3, 'W3')}
#50=IFCWALLTYPE('${gid('0type', 50)}',$,'WT',$,$,(${hasSets}),$,$,$,.STANDARD.);
${qset(51, 52)}
${length(52, 'Length', typeLength.value, typeLength.unit)}
#53=IFCPROPERTYSET('${gid('0pset', 53)}',$,'Pset_TypeSet',$,(#54));
#54=IFCPROPERTYSINGLEVALUE('P',$,IFCLABEL('x'),$);
#55=IFCRELDEFINESBYTYPE('${gid('0rdbt', 55)}',$,$,$,(#${W1},#${W2},#${W3}),#50);
${qset(60, 61)}
${length(61, 'Width', '0.2')}
${own(62, W2, 60)}
${qset(70, 71)}
${length(71, 'Length', '7.')}
${own(72, W3, 70)}
${(typeSets?.lines ?? []).join('\n')}
ENDSEC;
END-ISO-10303-21;`;
}

async function accessorFor(fixture?: Fixture): Promise<IFCDataAccessor> {
  const bytes = new TextEncoder().encode(model(fixture));
  return createDataAccessor(await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer));
}

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });
const facet = (pset: string, name: string, value?: string, dataType = 'IFCLENGTHMEASURE'): IDSPropertyFacet => ({
  type: 'property',
  propertySet: sv(pset),
  baseName: sv(name),
  dataType: sv(dataType),
  ...(value === undefined ? {} : { value: sv(value) }),
});
const length = (value?: string) => facet('Qto_WallBaseQuantities', 'Length', value);

describe('IDS: quantity sets held by a type object are inherited (#ISSUE)', () => {
  for (const schema of SCHEMAS) {
    it(`${schema}: a quantity only the type holds passes on the occurrence and on the type`, async () => {
      const a = await accessorFor({ schema });
      expect(checkPropertyFacet(length('5'), W1, a).passed).toBe(true);
      expect(checkPropertyFacet(length('5'), WT, a).passed).toBe(true);
      // Control: the type's property set, inherited before the fix too.
      expect(checkPropertyFacet(facet('Pset_TypeSet', 'P', 'x', 'IFCLABEL'), W1, a).passed).toBe(true);
    });

    it(`${schema}: the type's quantities join the occurrence's set of the same name, the occurrence's own value wins`, async () => {
      const a = await accessorFor({ schema });
      const sets = a.getPropertySets(W2).filter((s) => s.name === 'Qto_WallBaseQuantities');
      expect(sets).toHaveLength(1);
      expect(sets[0].properties.map((p) => [p.name, p.value]).sort()).toEqual([['Length', 5], ['Width', 0.2]]);
      expect(checkPropertyFacet(length('5'), W2, a).passed).toBe(true);
      // W3's own Length 7 overrides the type's 5, before and after the fix.
      expect(checkPropertyFacet(length('7'), W3, a).passed).toBe(true);
      const overridden = checkPropertyFacet(length('5'), W3, a);
      expect(overridden.passed).toBe(false);
      expect(overridden.failure?.type).toBe('PROPERTY_VALUE_MISMATCH');
    });

    it(`${schema}: a property applicability selects the walls that inherit the quantity`, async () => {
      const a = await accessorFor({ schema });
      const ids = parseIDS(`<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Applicable by a type quantity</title></info>
  <specifications>
    <specification name="Walls with a Length" ifcVersion="${schema}">
      <applicability minOccurs="0" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
        <property dataType="IFCLENGTHMEASURE">
          <propertySet><simpleValue>Qto_WallBaseQuantities</simpleValue></propertySet>
          <baseName><simpleValue>Length</simpleValue></baseName>
        </property>
      </applicability>
      <requirements><attribute><name><simpleValue>Name</simpleValue></name></attribute></requirements>
    </specification>
  </specifications>
</ids>`);
      const report = await validateIDS(ids, a, { modelId: 'm', schemaVersion: schema, entityCount: 3 }, { includePassingEntities: true });
      const spec = report.specificationResults[0];
      expect(spec.entityResults.map((e) => e.expressId).sort()).toEqual([W1, W2, W3]);
      expect(spec.status).toBe('pass');
    });
  }

  it('converts an inherited quantity with the occurrence project unit', async () => {
    const a = await accessorFor({ lengthUnit: '.MILLI.,.METRE.', typeLength: { value: '5000.' } });
    expect(checkPropertyFacet(length('5'), W1, a).passed).toBe(true);
    expect(checkPropertyFacet(length('5000'), W1, a).passed).toBe(false);
  });

  it("converts an inherited quantity with the quantity's own Unit", async () => {
    const a = await accessorFor({ typeLength: { value: '5000.', unit: '#4' } });
    expect(checkPropertyFacet(length('5'), W1, a).passed).toBe(true);
  });

  it('tops up a type property set of the same name rather than listing a second set', async () => {
    // Pset_TypeSet is also the name of a type quantity set here. Kept apart,
    // each set would fail the other's requirement, and P = x passed before.
    const a = await accessorFor({
      typeSets: {
        ids: [56],
        lines: [
          "#56=IFCELEMENTQUANTITY('0qto000000000000000056',$,'Pset_TypeSet',$,$,(#57));",
          "#57=IFCQUANTITYCOUNT('N',$,$,3.,$);",
        ],
      },
    });
    for (const id of [W1, WT]) {
      expect(a.getPropertySets(id).filter((s) => s.name === 'Pset_TypeSet')).toHaveLength(1);
      expect(checkPropertyFacet(facet('Pset_TypeSet', 'P', 'x', 'IFCLABEL'), id, a).passed).toBe(true);
      expect(checkPropertyFacet(facet('Pset_TypeSet', 'N', '3', 'IFCCOUNTMEASURE'), id, a).passed).toBe(true);
    }
  });

  it('does not pass an inherited quantity of another measure or invent one', async () => {
    const a = await accessorFor();
    const area = checkPropertyFacet(facet('Qto_WallBaseQuantities', 'Length', undefined, 'IFCAREAMEASURE'), W1, a);
    expect(area.passed).toBe(false);
    expect(area.failure?.type).toBe('PROPERTY_DATATYPE_MISMATCH');
    const height = checkPropertyFacet(facet('Qto_WallBaseQuantities', 'Height'), W1, a);
    expect(height.passed).toBe(false);
    expect(height.failure?.type).toBe('PROPERTY_MISSING');
  });
});
