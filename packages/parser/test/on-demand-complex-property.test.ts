/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser, extractPropertiesOnDemand } from '../src/columnar-parser.js';

describe('parseLite on-demand IfcComplexProperty extraction', () => {
  it('resolves the nested HasProperties of an IfcComplexProperty instead of showing UsageName as the value', async () => {
    const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(100.0),$);
#21=IFCPROPERTYSINGLEVALUE('Height',$,IFCLENGTHMEASURE(200.0),$);
#22=IFCCOMPLEXPROPERTY('Opening','desc','Reference',(#20,#21));
#30=IFCPROPERTYSET('pset-guid',#1,'Pset_WallOpening',$,(#22));
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
    expect(psets[0].properties).toHaveLength(1);
    const complex = psets[0].properties[0];
    expect(complex.name).toBe('Opening');
    // The nested Width/Height single-values must survive — not be replaced by
    // the bare UsageName string with the two child properties silently dropped.
    expect(complex.values).toEqual(expect.arrayContaining([
      expect.stringContaining('100'),
      expect.stringContaining('200'),
    ]));
    expect(complex.value).not.toBe('Reference');
  });
});
