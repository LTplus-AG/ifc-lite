/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { discoverFilterValues } from './filter-schema.js';
import { evaluateFilterRules } from '@ifc-lite/rules';
import { Rule } from '@ifc-lite/rules';

/**
 * One level deeper than #4780/#4815 (Name-vs-Category): Wall-D carries two
 * `IfcRelAssociatesMaterial` relationships. The lower relationship id points
 * to "Common Mat" and the higher, non-primary association points to "Rare
 * Find". Wall-E carries one association as the additive bounding control.
 */
const MULTI_ASSOC_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000003',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#80= IFCWALL('0WallTwoAssoc00000001',$,'Wall-D',$,$,#40,$,$,$);
#81= IFCWALL('0WallOneAssoc00000001',$,'Wall-E',$,$,#40,$,$,$);
#63= IFCMATERIAL('Common Mat',$,$);
#64= IFCMATERIAL('Rare Find',$,$);
#65= IFCMATERIAL('Lone Value',$,$);
#73= IFCRELASSOCIATESMATERIAL('0Rel00000000000000006',$,$,$,(#80),#63);
#74= IFCRELASSOCIATESMATERIAL('0Rel00000000000000007',$,$,$,(#80),#64);
#75= IFCRELASSOCIATESMATERIAL('0Rel00000000000000008',$,$,$,(#81),#65);
ENDSEC;
END-ISO-10303-21;
`;

const WALL_TWO_ASSOC = 80;

async function parseMultiAssocStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(MULTI_ASSOC_IFC);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

describe('discoverFilterValues — every matched material association is discoverable', () => {
  it('the matcher finds values on both the primary and non-primary associations', async () => {
    const store = await parseMultiAssocStore();
    for (const material of ['Common Mat', 'Rare Find']) {
      const out = evaluateFilterRules('m1', store, [Rule.material('eq', material)], 'AND');
      assert.deepStrictEqual(out.map((entity) => entity.expressId), [WALL_TWO_ASSOC]);
    }
  });

  it('offers the non-primary value while retaining primary and single-association values', async () => {
    const schema = discoverFilterValues(await parseMultiAssocStore());
    for (const material of ['Rare Find', 'Common Mat', 'Lone Value']) {
      assert.ok(
        schema.materials.includes(material),
        `expected ${JSON.stringify(material)} among discovered materials, got: ${JSON.stringify(schema.materials)}`,
      );
    }
  });
});
