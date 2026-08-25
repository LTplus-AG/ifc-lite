/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IfcPhysicalComplexQuantity handling (#3254).
 *
 * A complex quantity groups other quantities instead of carrying a value.
 * `IFC4_ADD2_TC1.exp` (identically `IFC4X3.exp`):
 *
 *     ENTITY IfcPhysicalComplexQuantity
 *      SUBTYPE OF (IfcPhysicalQuantity);
 *         HasQuantities : SET [1:?] OF IfcPhysicalQuantity;
 *         Discrimination : IfcLabel;
 *         ...
 *
 * With Name[0]/Description[1] inherited, slot 3 is `Discrimination` — a label,
 * not a measure. Both extraction paths used to read slot 3 as a value and fall
 * back to `QuantityType.Count`, emitting a phantom `Count = 0`.
 *
 * Every case below carries a SIMPLE control quantity next to the complex one,
 * so a regression that broke the whole walk equally cannot pass.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StepTokenizer } from '../src/tokenizer.js';
import {
  ColumnarParser,
  extractQuantitiesOnDemand,
  extractTypeQuantitiesOnDemand,
} from '../src/columnar-parser.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import { QuantityType, RelationshipType } from '@ifc-lite/data';

/**
 * Anti-vacuity: derive the premise from the schema rather than restating a
 * memorised slot number, so this test fails if the premise stops holding.
 */
function complexQuantityAttributes(schemaFile: string): string[] {
  const exp = readFileSync(
    fileURLToPath(new URL(`../../codegen/schemas/${schemaFile}`, import.meta.url)),
    'utf8',
  );
  const body = exp.match(/ENTITY IfcPhysicalComplexQuantity\b[\s\S]*?END_ENTITY;/)?.[0];
  if (!body) throw new Error(`IfcPhysicalComplexQuantity not found in ${schemaFile}`);
  const declared = [...body.matchAll(/^\t(\w+)\s*:/gm)].map((m) => m[1]);
  // Name and Description are inherited from IfcPhysicalQuantity and take the
  // first two flattened slots.
  return ['Name', 'Description', ...declared];
}

const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCQUANTITYLENGTH('NetWidth',$,$,0.25,$);
#21=IFCQUANTITYAREA('SideAreaLeft',$,$,12.5,$);
#22=IFCQUANTITYAREA('SideAreaRight',$,$,13.5,$);
#23=IFCPHYSICALCOMPLEXQUANTITY('SideAreas',$,(#21,#22),'side','net',$);
#30=IFCELEMENTQUANTITY('qto-guid',#1,'Qto_WallBaseQuantities',$,$,(#20,#23));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);
#50=IFCWALLTYPE('type-guid',#1,'WallType A',$,$,$,$,$,$,.STANDARD.);
#60=IFCQUANTITYLENGTH('TypeWidth',$,$,0.3,$);
#61=IFCQUANTITYVOLUME('PartVolume',$,$,4.0,$);
#62=IFCPHYSICALCOMPLEXQUANTITY('TypeParts',$,(#61),'part','net',$);
#70=IFCELEMENTQUANTITY('tqto-guid',#1,'Qto_WallTypeBase',$,$,(#60,#62));`;

async function parse(ifc: string): Promise<IfcDataStore> {
  const source = new TextEncoder().encode(ifc);
  const tokenizer = new StepTokenizer(source);
  const entityRefs = [...tokenizer.scanEntitiesFast()].map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0), entityRefs, {});
}

/** Wire up the DefinesByType relationship the type path resolves through. */
function withTypeOf(store: IfcDataStore, elementId: number, typeId: number, qsetIds: number[]): IfcDataStore {
  const mutable = store as unknown as Record<string, unknown>;
  mutable.relationships = {
    getRelated: (id: number, relType: RelationshipType, direction: string) =>
      id === elementId && relType === RelationshipType.DefinesByType && direction === 'inverse' ? [typeId] : [],
    hasRelationship: () => false,
    getRelationshipsBetween: () => [],
  };
  mutable.onDemandQuantityMap = new Map([[typeId, qsetIds]]);
  return store;
}

describe('IfcPhysicalComplexQuantity (#3254)', () => {
  it.each(['IFC4_ADD2_TC1.exp', 'IFC4X3.exp'])(
    'holds HasQuantities at slot 2 and a label at slot 3 in %s',
    (schemaFile) => {
      const attrs = complexQuantityAttributes(schemaFile);
      expect(attrs.length).toBeGreaterThan(3);
      expect(attrs[2]).toBe('HasQuantities');
      // Slot 3 is where a simple quantity keeps its measure; here it is a
      // label, which is why the old `typeof attrs[3] === 'number'` test failed
      // and the value settled at 0.
      expect(attrs[3]).toBe('Discrimination');
    },
  );

  it('skips a complex quantity on the instance path', async () => {
    const store = await parse(IFC);
    const qsets = extractQuantitiesOnDemand(store, 10);

    expect(qsets).toHaveLength(1);
    expect(qsets[0].name).toBe('Qto_WallBaseQuantities');
    // Control: the simple quantity beside it still comes through intact.
    expect(qsets[0].quantities).toEqual([
      { name: 'NetWidth', type: QuantityType.Length, value: 0.25 },
    ]);

    // No phantom row bearing the complex quantity's own name, and nothing
    // zero-valued to pollute a total or satisfy an existence check.
    expect(qsets[0].quantities.some((q) => q.name === 'SideAreas')).toBe(false);
    expect(qsets[0].quantities.some((q) => q.value === 0)).toBe(false);
  });

  it('skips a complex quantity on the type path', async () => {
    const store = withTypeOf(await parse(IFC), 10, 50, [70]);
    const typeQuantities = extractTypeQuantitiesOnDemand(store, 10);

    expect(typeQuantities).not.toBeNull();
    expect(typeQuantities!.quantities).toHaveLength(1);
    expect(typeQuantities!.quantities[0].name).toBe('Qto_WallTypeBase');
    expect(typeQuantities!.quantities[0].quantities).toEqual([
      { name: 'TypeWidth', type: QuantityType.Length, value: 0.3 },
    ]);
    expect(typeQuantities!.quantities[0].quantities.some((q) => q.name === 'TypeParts')).toBe(false);
  });

  it('does not let a complex quantity shadow a simple one of the same measure', async () => {
    // The complex quantity is listed FIRST, so a reader that emitted a row for
    // it would hand a name-keyed consumer the phantom before the real value.
    const store = await parse(`#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#21=IFCQUANTITYVOLUME('Part',$,$,3.0,$);
#22=IFCPHYSICALCOMPLEXQUANTITY('NetVolume',$,(#21),'part','net',$);
#23=IFCQUANTITYVOLUME('GrossVolume',$,$,9.0,$);
#30=IFCELEMENTQUANTITY('qto-guid',#1,'Qto_WallBaseQuantities',$,$,(#22,#23));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);`);

    const quantities = extractQuantitiesOnDemand(store, 10)[0].quantities;
    expect(quantities).toEqual([
      { name: 'GrossVolume', type: QuantityType.Volume, value: 9.0 },
    ]);
    // A summing consumer sees only the real measure.
    expect(quantities.reduce((sum, q) => sum + q.value, 0)).toBeCloseTo(9.0);
  });

  it('still reports simple quantities when every entry in the set is complex', async () => {
    const store = await parse(`#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#21=IFCQUANTITYAREA('Inner',$,$,7.5,$);
#22=IFCPHYSICALCOMPLEXQUANTITY('OnlyComplex',$,(#21),'mid','net',$);
#30=IFCELEMENTQUANTITY('qto-guid',#1,'Qto_AllComplex',$,$,(#22));
#31=IFCQUANTITYLENGTH('NetWidth',$,$,0.25,$);
#32=IFCELEMENTQUANTITY('qto2-guid',#1,'Qto_WallBaseQuantities',$,$,(#31));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);
#41=IFCRELDEFINESBYPROPERTIES('rel2-guid',#1,$,$,(#10),#32);`);

    const qsets = extractQuantitiesOnDemand(store, 10);
    const byName = new Map(qsets.map((q) => [q.name, q.quantities]));
    // The all-complex set contributes no quantities at all, so it walks to an
    // empty `IfcElementQuantity` and is dropped entirely (#3259): `Quantities`
    // is `SET [1:?]`, and reporting the name alone would claim the element has
    // quantities when it has none.
    expect(byName.has('Qto_AllComplex')).toBe(false);
    // ...while the control set beside it is untouched.
    expect(byName.get('Qto_WallBaseQuantities')).toEqual([
      { name: 'NetWidth', type: QuantityType.Length, value: 0.25 },
    ]);
  });
});
