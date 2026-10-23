/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser, extractPropertiesOnDemand, type IfcDataStore } from '../src/columnar-parser.js';
import { COMPLEX_PROPERTY_BUDGET_MARKER, complexPropertyOutputBudget } from '../src/property-complex-value.js';
import { complexPropertyCuts } from '../src/complex-property-store.js';

/**
 * #7675, #7718 round-2 review finding 2: the bulk paths (lists, IDS, compare,
 * collab seed, rules) call `extractPropertiesOnDemand` once per entity. With a
 * budget per call, one set shared by N walls was walked N times: 60 walls of
 * an 18.6 KB file held 2.08 GB of heap, 200 walls ran out of memory, and 1000
 * walls (78 KB) built 1.05 GB in 115 s. The store resolves each listing once,
 * against one budget relative to the input, and every wall shares the value.
 */
const WALLS = 1000;

function sharedSetFile(walls: number): string {
  const ids = Array.from({ length: walls }, (_, i) => 100 + i);
  return [
    "#1=IFCPROJECT('Proj0000000000000007675',$,'P',$,$,$,$,$,$);",
    `#20=IFCPROPERTYSINGLEVALUE('Long',$,IFCLABEL('${'u'.repeat(10240)}'),$);`,
    `#22=IFCCOMPLEXPROPERTY('Wide',$,'WideUsage',(${Array(1100).fill('#20').join(',')}));`,
    "#30=IFCPROPERTYSET('Pset0000000000000007678',$,'Pset_Shared',$,(#22));",
    ...ids.map(id => `#${id}=IFCWALL('W${String(id).padStart(21, '0')}',$,'W',$,$,$,$,$,$);`),
    `#40=IFCRELDEFINESBYPROPERTIES('Rel00000000000000007678',$,$,$,(${ids.map(id => `#${id}`).join(',')}),#30);`,
  ].join('\n');
}

async function parse(text: string): Promise<IfcDataStore> {
  const source = new TextEncoder().encode(text);
  const entityRefs = [...new StepTokenizer(source).scanEntitiesFast()].map(ref => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  return new ColumnarParser().parseLite(source.buffer.slice(0), entityRefs, {});
}

describe('a complex property shared by many entities (#7675)', () => {
  it('is resolved once per store, so retained heap does not grow with the entity count', async () => {
    const text = sharedSetFile(WALLS);
    const store = await parse(text);
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const retained = Array.from({ length: WALLS }, (_, i) => extractPropertiesOnDemand(store, 100 + i));
    const elapsedMs = performance.now() - started;
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

    const first = retained[0][0].properties[0];
    for (const sets of retained) {
      const wide = sets[0].properties[0];
      expect(wide.value).toBe(first.value);
      // The same arrays, not copies: one materialisation for every wall.
      expect(wide.members).toBe(first.members);
      expect(wide.values).toBe(first.values);
    }
    const valueBytes = Buffer.byteLength(String(first.value), 'utf8');
    expect(valueBytes).toBeLessThanOrEqual(complexPropertyOutputBudget(text.length));
    // Was 1.05 GB built over 115 s; one value plus the walls' small entries.
    expect(heapGrowth, `${(heapGrowth / 2 ** 20).toFixed(1)} MiB retained`).toBeLessThan(64 * 2 ** 20);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('marks the cut in members and values, and counts it (D3)', async () => {
    const store = await parse(sharedSetFile(3));
    const wide = extractPropertiesOnDemand(store, 100)[0].properties[0];
    expect(String(wide.value).endsWith(COMPLEX_PROPERTY_BUDGET_MARKER)).toBe(true);
    // A member past the cut reads as truncated, not absent.
    expect(wide.values?.at(-1)).toBe(COMPLEX_PROPERTY_BUDGET_MARKER);
    expect(wide.members?.at(-1)).toMatchObject({ name: COMPLEX_PROPERTY_BUDGET_MARKER, value: COMPLEX_PROPERTY_BUDGET_MARKER });
    expect(wide.members!.length).toBeLessThan(1100);
    expect(complexPropertyCuts(store)).toBe(1);
  });
});
