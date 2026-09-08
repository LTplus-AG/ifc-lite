/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens sees type-inherited properties even when the occurrence carries a
 * property set of the same name (#1913).
 *
 * `Pset_CoveringCommon` split across an IfcCovering and its IfcCoveringType is
 * a plain Revit export. Dropping the whole inherited set on the name collision
 * made every type-only property invisible to Lens grouping and filtering, the
 * same root cause that made IDS report a present property as missing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types';
import { createLensDataProvider } from './adapter';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCCOVERING('0covering000000000000a',$,'cladding batten',$,$,$,$,'1996845',.CLADDING.);
#11=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#12=IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('cladding batten'),$);
#13=IFCPROPERTYSET('0pset0000000000000inst',$,'Pset_CoveringCommon',$,(#11,#12));
#14=IFCRELDEFINESBYPROPERTIES('0rel00000000000000inst',$,$,$,(#10),#13);
#21=IFCPROPERTYSINGLEVALUE('Combustible',$,IFCBOOLEAN(.F.),$);
#22=IFCPROPERTYSINGLEVALUE('SurfaceSpreadOfFlame',$,IFCLABEL('B'),$);
#24=IFCPROPERTYSET('0pset0000000000000type',$,'Pset_CoveringCommon',$,(#21,#22));
#25=IFCCOVERINGTYPE('0type000000000000000a',$,'cladding batten type',$,$,(#24),$,$,$,.CLADDING.);
#26=IFCRELDEFINESBYTYPE('0rel00000000000000type',$,$,$,(#10),#25);
ENDSEC;
END-ISO-10303-21;`;

const parse = (src: string) =>
  new IfcParser().parseColumnar(new TextEncoder().encode(src).buffer, {
    disableWorkerScan: true,
  });

async function provider() {
  // Single-model fallback: globalId === expressId.
  return createLensDataProvider(new Map(), await parse(FIXTURE));
}

/** Only the fields `createLensDataProvider` reads off a FederatedModel. */
function federatedModel(id: string, ifcDataStore: IfcDataStore, idOffset: number) {
  return { id, name: id, ifcDataStore, idOffset, maxExpressId: 999 } as FederatedModel;
}

describe('lens adapter: same-named occurrence and type property sets (#1913)', () => {
  it('merges both sides into one Pset_CoveringCommon', async () => {
    const sets = (await provider()).getPropertySets(10)
      .filter((p) => p.name === 'Pset_CoveringCommon');

    assert.equal(sets.length, 1);
    assert.deepEqual(
      sets[0].properties.map((p) => p.name).sort(),
      ['Combustible', 'IsExternal', 'Reference', 'SurfaceSpreadOfFlame'],
    );
  });

  it('keeps getPropertyValue agreeing with getPropertySets on both sides', async () => {
    const p = await provider();
    assert.equal(p.getPropertyValue(10, 'Pset_CoveringCommon', 'SurfaceSpreadOfFlame'), 'B');
    assert.equal(p.getPropertyValue(10, 'Pset_CoveringCommon', 'IsExternal'), true);
    assert.equal(p.getPropertyValue(10, 'Pset_CoveringCommon', 'Finish'), undefined);
  });

  // AGENTS.md: verify at `models.size` of 1 AND N. The single-model cases above
  // ride the `globalId === expressId` fallback; this one proves the merge reads
  // the resolved model's own store rather than the first entry's.
  it('resolves the merged set against the right model when federated', async () => {
    const first = await parse(FIXTURE);
    const second = await parse(FIXTURE.replace("IFCLABEL('B')", "IFCLABEL('A1')"));
    const models = new Map([
      ['m1', federatedModel('m1', first, 0)],
      ['m2', federatedModel('m2', second, 1000)],
    ]);
    const p = createLensDataProvider(models, null);

    assert.equal(p.getPropertyValue(10, 'Pset_CoveringCommon', 'SurfaceSpreadOfFlame'), 'B');
    assert.equal(p.getPropertyValue(1010, 'Pset_CoveringCommon', 'SurfaceSpreadOfFlame'), 'A1');

    for (const globalId of [10, 1010]) {
      const sets = p.getPropertySets(globalId).filter((s) => s.name === 'Pset_CoveringCommon');
      assert.equal(sets.length, 1, `model for globalId ${globalId}`);
      assert.deepEqual(
        sets[0].properties.map((prop) => prop.name).sort(),
        ['Combustible', 'IsExternal', 'Reference', 'SurfaceSpreadOfFlame'],
      );
    }
  });
});

/**
 * The quantity counterpart of the #1913 case above: `getPropertyValue`/
 * `getPropertySets` fall back to type-inherited PROPERTY sets, but
 * `getQuantityValue`/`getQuantitySets` looked only at the occurrence's own
 * quantity sets — a type-level `Qto_*` set (`IfcElementQuantity` reached via
 * `IfcTypeProduct.HasPropertySets`, e.g. Revit's `Qto_WallBaseQuantities` on
 * `IfcWallType`) was invisible to every Lens coloring/filtering rule and to
 * the rule-builder's own set/quantity discovery, even though IFC defines
 * quantities as inherited exactly like properties.
 */
const QUANTITY_FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('0wall000000000000000a',$,'wall',$,$,$,$,$,$);
#20=IFCQUANTITYLENGTH('Width',$,$,0.2,$);
#21=IFCELEMENTQUANTITY('0qto00000000000000inst',$,'Qto_WallBaseQuantities',$,$,(#20));
#22=IFCRELDEFINESBYPROPERTIES('0rel00000000000000inst',$,$,$,(#10),#21);
#30=IFCQUANTITYLENGTH('Width',$,$,3.0,$);
#31=IFCQUANTITYLENGTH('Height',$,$,2.4,$);
#32=IFCELEMENTQUANTITY('0qto00000000000000type',$,'Qto_WallBaseQuantities',$,$,(#30,#31));
#40=IFCQUANTITYAREA('GrossFootprintArea',$,$,1.5,$);
#41=IFCELEMENTQUANTITY('0qto00000000000000type2',$,'Qto_WallTypeExtra',$,$,(#40));
#50=IFCWALLTYPE('0type000000000000000a',$,'wall type',$,$,(#32,#41),$,$,$,.STANDARD.);
#51=IFCRELDEFINESBYTYPE('0rel00000000000000type',$,$,$,(#10),#50);
ENDSEC;
END-ISO-10303-21;`;

describe('lens adapter: type-inherited quantity sets', () => {
  it('merges the occurrence and type Qto_WallBaseQuantities, occurrence winning the Width collision', async () => {
    const p = createLensDataProvider(new Map(), await parse(QUANTITY_FIXTURE));

    const sets = (p.getQuantitySets?.(10) ?? []).filter((s) => s.name === 'Qto_WallBaseQuantities');
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0].quantities.map((q) => q.name).sort(), ['Height', 'Width']);

    // Occurrence's own Width (0.2) wins over the type's Width (3.0); Height is
    // type-only and must still be reachable.
    assert.equal(p.getQuantityValue?.(10, 'Qto_WallBaseQuantities', 'Width'), 0.2);
    assert.equal(p.getQuantityValue?.(10, 'Qto_WallBaseQuantities', 'Height'), 2.4);
  });

  it('exposes a quantity set that lives only on the type (no occurrence counterpart)', async () => {
    const p = createLensDataProvider(new Map(), await parse(QUANTITY_FIXTURE));

    assert.equal(p.getQuantityValue?.(10, 'Qto_WallTypeExtra', 'GrossFootprintArea'), 1.5);
    const names = (p.getQuantitySets?.(10) ?? []).map((s) => s.name);
    assert.ok(names.includes('Qto_WallTypeExtra'));
  });
});
