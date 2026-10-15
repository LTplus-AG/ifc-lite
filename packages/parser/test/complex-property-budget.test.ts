/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser, extractPropertiesOnDemand } from '../src/columnar-parser.js';

/**
 * #7675: the `IfcComplexProperty` depth cap bounds a path's LENGTH only, so a
 * member listing itself `k` times was `k^8` reads, and one visit can copy a
 * long name. The walk is bounded by member visits per property and output
 * bytes per `extractPsetsFromIds` call, mirroring `ifc_lite_core::limits`. The
 * vector is shared with the server (`complex_property_walk_budget_matches_the_shared_vector`
 * in `apps/server/src/services/data_model/tests.rs`) and the Rust exporter
 * (`rust/export/src/step_log/base_tests.rs`), so all three walks stay
 * byte-identical.
 */
interface PinnedCase {
  property: string;
  value?: string;
  length?: number;
  sha256?: string;
  count?: number;
}
interface BudgetVector {
  dataLines: string[];
  wallId: number;
  maxTotalBytes: number;
  psets: Array<{ name: string; properties?: PinnedCase[]; repeated?: PinnedCase }>;
}

const vector: BudgetVector = JSON.parse(
  readFileSync(new URL('./fixtures/complex-property-budget-7675.json', import.meta.url), 'utf8')
);

const pinned = (text: string): [number, string] => [
  Buffer.byteLength(text, 'utf8'),
  createHash('sha256').update(text, 'utf8').digest('hex'),
];

async function budgetSets(): Promise<Array<{ name: string; values: Array<[string, string]> }>> {
  const source = new TextEncoder().encode(vector.dataLines.join('\n'));
  const tokenizer = new StepTokenizer(source);
  const entityRefs = [...tokenizer.scanEntitiesFast()].map(ref => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  const store = await new ColumnarParser().parseLite(source.buffer.slice(0), entityRefs, {});
  return extractPropertiesOnDemand(store, vector.wallId).map(set => ({
    name: set.name,
    values: set.properties.map(p => [p.name, p.value == null ? '' : String(p.value)] as [string, string]),
  }));
}

describe('IfcComplexProperty walk budget (#7675)', () => {
  it('matches the server and the exporter for every case in the shared vector', async () => {
    const sets = await budgetSets();
    const total = sets.reduce((n, s) => n + s.values.reduce((m, [, v]) => m + Buffer.byteLength(v, 'utf8'), 0), 0);
    expect(total).toBeLessThanOrEqual(vector.maxTotalBytes);
    for (const expected of vector.psets) {
      const set = sets.find(s => s.name === expected.name);
      expect(set, expected.name).toBeDefined();
      if (expected.repeated) {
        expect(set!.values.length, expected.name).toBe(expected.repeated.count);
        const joined = set!.values.map(([, v]) => v).join('\n');
        expect(pinned(joined), expected.name).toEqual([expected.repeated.length, expected.repeated.sha256]);
        continue;
      }
      for (const c of expected.properties ?? []) {
        const value = set!.values.find(([n]) => n === c.property)?.[1];
        expect(value, c.property).toBeDefined();
        if (c.value !== undefined) expect(value, c.property).toBe(c.value);
        else expect(pinned(value!), c.property).toEqual([c.length, c.sha256]);
      }
    }
  });
});
