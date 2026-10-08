/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { extractAllMaterialsOnDemand } from '../src/material-resolver.js';

async function parse(name: string, target = 3, targetType = 'IFCMATERIAL') {
  // #7211 invariant: a decoded STEP null is distinguishable from an unreadable record.
  const source = new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#2=IFCPROJECT('0Project00000000000001',$,'P',$,$,$,$,$,$);
#1=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,$);
#3=${targetType}(${name},$,$);
#4=IFCMATERIALLIST((#${target}));
#5=IFCRELASSOCIATESMATERIAL('0Rel000000000000000001',$,$,$,(#1),#4);
ENDSEC;END-ISO-10303-21;`);
  const refs = [...new StepTokenizer(source).scanEntitiesFast()].map(ref => ({
    expressId: ref.expressId, type: ref.type, byteOffset: ref.offset, byteLength: ref.length, lineNumber: ref.line,
  }));
  return new ColumnarParser().parseLite(source.buffer.slice(0), refs, {});
}
describe('#7211 decoded material-list Name availability', () => {
  for (const [name, expected] of [['$', 'Material #3'], ["''", ''], ["'Named'", 'Named']] as const) {
    it(`keeps known ${name} Name resolved`, async () => {
      const store = await parse(name);
      const material = extractAllMaterialsOnDemand(store, 1)[0];
      expect(material.type).toBe('MaterialList');
      expect(material.materials).toEqual([{ name: expected }]);
      expect(material.unresolved).not.toBe(true);
    });
  }
  it('preserves unknown evidence for a missing referenced material', async () => {
    const material = extractAllMaterialsOnDemand(await parse('$', 99999), 1)[0];
    expect(material.unresolved).toBe(true);
  });
  it('preserves unknown evidence for a wrong referenced EXPRESS type', async () => {
    const material = extractAllMaterialsOnDemand(await parse('$', 3, 'IFCSPACE'), 1)[0];
    expect(material.unresolved).toBe(true);
  });
  it('preserves unknown evidence for a non-label numeric Name', async () => {
    const material = extractAllMaterialsOnDemand(await parse('42'), 1)[0];
    expect(material.unresolved).toBe(true);
  });
});
