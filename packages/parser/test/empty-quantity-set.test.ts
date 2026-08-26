/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A named `IfcElementQuantity` that carries no quantities.
 *
 * `IFC4_ADD2_TC1.exp` (identically `IFC4X3.exp`):
 *
 *     ENTITY IfcElementQuantity
 *      SUBTYPE OF (IfcQuantitySet);
 *         MethodOfMeasurement : OPTIONAL IfcLabel;
 *         Quantities : SET [1:?] OF IfcPhysicalQuantity;
 *
 * `SET [1:?]` makes an empty set non-conformant, so a reader that meets one is
 * looking at broken data. Surfacing it as a quantity set says "this element has
 * quantities" when it has none — a claim `validate`'s quantity-completeness
 * count, an IDS existence check and the viewer's type-quantity fallback all act
 * on. The instance path used to surface it while the type path dropped it, so
 * the same broken set read one way or the other depending on whether it hung
 * off the occurrence or off the type.
 *
 * A set whose every member is unreadable — an unresolvable reference, or an
 * `IfcPhysicalComplexQuantity`, which #3254 established carries no measure to
 * report — reduces to the same empty set after the walk and is treated alike.
 *
 * Every case carries a POPULATED control set beside the empty one, so a
 * regression that dropped all quantity sets equally cannot pass.
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
 * Anti-vacuity: read the cardinality out of the schema rather than restating
 * it, so this test fails if the premise it rests on stops holding.
 */
function quantitiesCardinality(schemaFile: string): string {
  const exp = readFileSync(
    fileURLToPath(new URL(`../../codegen/schemas/${schemaFile}`, import.meta.url)),
    'utf8',
  );
  const body = exp.match(/ENTITY IfcElementQuantity\b[\s\S]*?END_ENTITY;/)?.[0];
  if (!body) throw new Error(`IfcElementQuantity not found in ${schemaFile}`);
  const decl = body.match(/^\tQuantities\s*:\s*(.+?);/m)?.[1];
  if (!decl) throw new Error(`Quantities attribute not found in ${schemaFile}`);
  return decl;
}

/**
 * `Qto_Empty` is the non-conformant set; `Qto_*Base*` beside it is the control.
 * The element carries both, and so does its type — the same shape on each side
 * of the divergence, so the two paths can be compared directly.
 */
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCQUANTITYLENGTH('NetWidth',$,$,0.25,$);
#30=IFCELEMENTQUANTITY('empty-guid',#1,'Qto_Empty',$,$,());
#31=IFCELEMENTQUANTITY('qto-guid',#1,'Qto_WallBaseQuantities',$,$,(#20));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);
#41=IFCRELDEFINESBYPROPERTIES('rel2-guid',#1,$,$,(#10),#31);
#50=IFCWALLTYPE('type-guid',#1,'WallType A',$,$,$,$,$,$,.STANDARD.);
#60=IFCQUANTITYLENGTH('TypeWidth',$,$,0.3,$);
#70=IFCELEMENTQUANTITY('tempty-guid',#1,'Qto_Empty',$,$,());
#71=IFCELEMENTQUANTITY('tqto-guid',#1,'Qto_WallTypeBase',$,$,(#60));`;

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
  const quantityMap = (mutable.onDemandQuantityMap as Map<number, number[]> | undefined) ?? new Map<number, number[]>();
  mutable.relationships = {
    getRelated: (id: number, relType: RelationshipType, direction: string) =>
      id === elementId && relType === RelationshipType.DefinesByType && direction === 'inverse' ? [typeId] : [],
    hasRelationship: () => false,
    getRelationshipsBetween: () => [],
  };
  quantityMap.set(typeId, qsetIds);
  mutable.onDemandQuantityMap = quantityMap;
  return store;
}

/** Names of the quantity sets a path reported, in order. */
const names = (qsets: ReadonlyArray<{ name: string }>) => qsets.map((q) => q.name);

describe('empty IfcElementQuantity', () => {
  it.each(['IFC4_ADD2_TC1.exp', 'IFC4X3.exp'])(
    'is non-conformant in %s: Quantities is SET [1:?]',
    (schemaFile) => {
      expect(quantitiesCardinality(schemaFile)).toBe('SET [1:?] OF IfcPhysicalQuantity');
    },
  );

  it('is dropped by the instance path, which keeps the populated set beside it', async () => {
    const store = await parse(IFC);
    const qsets = extractQuantitiesOnDemand(store, 10);

    expect(names(qsets)).toEqual(['Qto_WallBaseQuantities']);
    // Control: the populated set is intact, so a regression that dropped
    // everything cannot pass this.
    expect(qsets[0].quantities).toEqual([
      { name: 'NetWidth', type: QuantityType.Length, value: 0.25 },
    ]);
  });

  it('is dropped by the type path, which keeps the populated set beside it', async () => {
    const store = withTypeOf(await parse(IFC), 10, 50, [70, 71]);
    const typeQuantities = extractTypeQuantitiesOnDemand(store, 10);

    expect(typeQuantities).not.toBeNull();
    expect(names(typeQuantities!.quantities)).toEqual(['Qto_WallTypeBase']);
    expect(typeQuantities!.quantities[0].quantities).toEqual([
      { name: 'TypeWidth', type: QuantityType.Length, value: 0.3 },
    ]);
  });

  it('reads the same whether the broken set hangs off the occurrence or the type', async () => {
    const store = withTypeOf(await parse(IFC), 10, 50, [70, 71]);

    const instanceEmpty = extractQuantitiesOnDemand(store, 10).filter((q) => q.quantities.length === 0);
    const typeEmpty = (extractTypeQuantitiesOnDemand(store, 10)?.quantities ?? []).filter(
      (q) => q.quantities.length === 0,
    );

    // The divergence, stated directly: both paths meet the same non-conformant
    // set and must reach the same verdict about it.
    expect(names(instanceEmpty)).toEqual(names(typeEmpty));
    expect(instanceEmpty).toEqual([]);
  });

  it('drops a set whose every member is unreadable, on both paths', async () => {
    // #21 is a dangling reference and #22 an IfcPhysicalComplexQuantity (#3254,
    // no measure to report): the set is written non-empty but walks to nothing.
    const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCQUANTITYLENGTH('NetWidth',$,$,0.25,$);
#22=IFCPHYSICALCOMPLEXQUANTITY('SideAreas',$,(#20),'side','net',$);
#30=IFCELEMENTQUANTITY('vac-guid',#1,'Qto_Vacuous',$,$,(#21,#22));
#31=IFCELEMENTQUANTITY('qto-guid',#1,'Qto_WallBaseQuantities',$,$,(#20));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);
#41=IFCRELDEFINESBYPROPERTIES('rel2-guid',#1,$,$,(#10),#31);
#50=IFCWALLTYPE('type-guid',#1,'WallType A',$,$,$,$,$,$,.STANDARD.);`;
    const store = withTypeOf(await parse(ifc), 10, 50, [30, 31]);

    expect(names(extractQuantitiesOnDemand(store, 10))).toEqual(['Qto_WallBaseQuantities']);
    expect(names(extractTypeQuantitiesOnDemand(store, 10)?.quantities ?? [])).toEqual([
      'Qto_WallBaseQuantities',
    ]);
  });
});
