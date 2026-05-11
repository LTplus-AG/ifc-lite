/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser, extractPropertiesOnDemand } from '../src/columnar-parser.js';

describe('parseLite on-demand property extraction', () => {
  it('keeps property atom refs indexed when property atoms are not deferred', async () => {
    const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,'REI60',$);
#21=IFCPROPERTYSINGLEVALUE('IsExternal',$,.T.,$);
#30=IFCPROPERTYSET('pset-guid',#1,'Pset_WallCommon',$,(#20,#21));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);`;

    const source = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(source);
    const entityRefs: Array<{
      expressId: number;
      type: string;
      byteOffset: number;
      byteLength: number;
      lineNumber: number;
    }> = [];

    for (const ref of tokenizer.scanEntitiesFast()) {
      entityRefs.push({
        expressId: ref.expressId,
        type: ref.type,
        byteOffset: ref.offset,
        byteLength: ref.length,
        lineNumber: ref.line,
      });
    }

    const parser = new ColumnarParser();
    const store = await parser.parseLite(source.buffer.slice(0), entityRefs, {});
    const psets = extractPropertiesOnDemand(store, 10);

    expect(psets).toHaveLength(1);
    expect(psets[0].name).toBe('Pset_WallCommon');
    expect(psets[0].properties).toHaveLength(2);
    expect(psets[0].properties.map((prop) => prop.name)).toEqual(['FireRating', 'IsExternal']);
  });

  it('normalizes untagged STEP boolean/logical tokens in NominalValue', async () => {
    const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('IsExternal',$,.T.,$);
#21=IFCPROPERTYSINGLEVALUE('LoadBearing',$,.F.,$);
#22=IFCPROPERTYSINGLEVALUE('Combustible',$,.U.,$);
#23=IFCPROPERTYSINGLEVALUE('FireRating',$,'REI60',$);
#24=IFCPROPERTYSINGLEVALUE('Height',$,IFCREAL(3000.0),$);
#30=IFCPROPERTYSET('pset-guid',#1,'Pset_WallCommon',$,(#20,#21,#22,#23,#24));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);`;

    const source = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(source);
    const entityRefs: Array<{
      expressId: number;
      type: string;
      byteOffset: number;
      byteLength: number;
      lineNumber: number;
    }> = [];
    for (const ref of tokenizer.scanEntitiesFast()) {
      entityRefs.push({
        expressId: ref.expressId,
        type: ref.type,
        byteOffset: ref.offset,
        byteLength: ref.length,
        lineNumber: ref.line,
      });
    }

    const parser = new ColumnarParser();
    const store = await parser.parseLite(source.buffer.slice(0), entityRefs, {});
    const psets = extractPropertiesOnDemand(store, 10);

    const byName = Object.fromEntries(
      psets[0].properties.map((p) => [p.name, { type: p.type, value: p.value }]),
    );

    expect(byName.IsExternal).toEqual({ type: 3, value: true }); // Boolean
    expect(byName.LoadBearing).toEqual({ type: 3, value: false });
    expect(byName.Combustible).toEqual({ type: 4, value: null }); // Logical (.U.)
    expect(byName.FireRating.value).toBe('REI60');
    expect(byName.Height.value).toBe(3000.0);
  });
});
