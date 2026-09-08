/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An occurrence and its type routinely BOTH carry a property set of the same
 * name, holding different properties — `Pset_CoveringCommon` with
 * `IsExternal`/`Reference` on the occurrence and
 * `SurfaceSpreadOfFlame`/`Combustible`/`ThermalTransmittance` on the type is a
 * plain Revit export. The bridge used to drop the whole inherited set on a
 * name collision, so every type-only property in it was invisible and IDS
 * reported a present property as missing (#1913).
 *
 * The fixture below is the shape of the reported model: a CLADDING IfcCovering
 * whose Pset_CoveringCommon is split across the occurrence and its
 * IfcCoveringType.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';
import { checkPropertyFacet } from '../facets/property-facet.js';
import type { IDSPropertyFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCCOVERING('0covering000000000000a',$,'cladding batten',$,$,$,$,'1996845',.CLADDING.);
/* Occurrence-side Pset_CoveringCommon */
#11=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#12=IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('cladding batten'),$);
#13=IFCPROPERTYSET('0pset0000000000000inst',$,'Pset_CoveringCommon',$,(#11,#12));
#14=IFCRELDEFINESBYPROPERTIES('0rel00000000000000inst',$,$,$,(#10),#13);
/* Type-side Pset_CoveringCommon — SAME NAME, different properties */
#21=IFCPROPERTYSINGLEVALUE('Combustible',$,IFCBOOLEAN(.F.),$);
#22=IFCPROPERTYSINGLEVALUE('SurfaceSpreadOfFlame',$,IFCLABEL('B'),$);
#23=IFCPROPERTYSINGLEVALUE('ThermalTransmittance',$,IFCTHERMALTRANSMITTANCEMEASURE(0.),$);
#24=IFCPROPERTYSET('0pset0000000000000type',$,'Pset_CoveringCommon',$,(#21,#22,#23));
#25=IFCCOVERINGTYPE('0type000000000000000a',$,'cladding batten type',$,$,(#24),$,$,$,.CLADDING.);
#26=IFCRELDEFINESBYTYPE('0rel00000000000000type',$,$,$,(#10),#25);
ENDSEC;
END-ISO-10303-21;`;

async function accessor() {
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(IFC).buffer,
    { disableWorkerScan: true },
  );
  return createDataAccessor(store);
}

const propertyFacet = (baseName: string, value?: string): IDSPropertyFacet => ({
  type: 'property',
  propertySet: sv('Pset_CoveringCommon'),
  baseName: sv(baseName),
  ...(value ? { value: sv(value) } : {}),
});

describe('IDS: occurrence and type property sets of the same name merge per property (#1913)', () => {
  it('resolves a type-only property when the occurrence has a same-named set', async () => {
    const a = await accessor();
    // The reported failure verbatim: SurfaceSpreadOfFlame="B" lives only on the
    // type, while the occurrence carries its own Pset_CoveringCommon.
    expect(checkPropertyFacet(propertyFacet('SurfaceSpreadOfFlame', 'B'), 10, a).passed).toBe(true);
    expect(checkPropertyFacet(propertyFacet('Combustible'), 10, a).passed).toBe(true);
    expect(checkPropertyFacet(propertyFacet('ThermalTransmittance'), 10, a).passed).toBe(true);
  });

  it('still resolves the occurrence-only properties of that set', async () => {
    const a = await accessor();
    expect(checkPropertyFacet(propertyFacet('IsExternal', 'true'), 10, a).passed).toBe(true);
    expect(checkPropertyFacet(propertyFacet('Reference'), 10, a).passed).toBe(true);
  });

  it('reports one merged Pset_CoveringCommon carrying all five properties', async () => {
    const a = await accessor();
    const sets = a.getPropertySets(10).filter((p) => p.name === 'Pset_CoveringCommon');
    expect(sets).toHaveLength(1);
    expect(sets[0].properties.map((p) => p.name).sort()).toEqual([
      'Combustible',
      'IsExternal',
      'Reference',
      'SurfaceSpreadOfFlame',
      'ThermalTransmittance',
    ]);
  });

  it('does not report a property that exists on neither side', async () => {
    const a = await accessor();
    // `Finish` is in the schema's Pset_CoveringCommon but absent from this
    // model — the merge must not invent it.
    expect(checkPropertyFacet(propertyFacet('Finish'), 10, a).passed).toBe(false);
  });
});
