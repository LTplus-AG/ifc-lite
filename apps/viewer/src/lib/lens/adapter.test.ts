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
