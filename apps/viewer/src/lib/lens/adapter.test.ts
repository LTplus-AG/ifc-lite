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
import { IfcParser } from '@ifc-lite/parser';
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

async function provider() {
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(FIXTURE).buffer,
    { disableWorkerScan: true },
  );
  // Single-model fallback: globalId === expressId.
  return createLensDataProvider(new Map(), store);
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
});
