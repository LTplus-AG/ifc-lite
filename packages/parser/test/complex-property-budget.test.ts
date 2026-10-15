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
 * member listing itself `k` times was `k^8` reads (an 82 MB value at `k = 6`).
 * One budget of nested-member reads is shared by the whole walk. The vector is
 * shared with the server (`complex_property_member_budget_matches_the_typescript_parser`
 * in `apps/server/src/services/data_model/tests.rs`), so the two walks and
 * their marker stay byte-identical.
 */
interface BudgetCase {
  property: string;
  value?: string;
  length?: number;
  sha256?: string;
  suffix?: string;
}
interface BudgetVector {
  dataLines: string[];
  wallId: number;
  cases: BudgetCase[];
}

const vector: BudgetVector = JSON.parse(
  readFileSync(new URL('./fixtures/complex-property-budget-7675.json', import.meta.url), 'utf8')
);

async function budgetValues(): Promise<Map<string, string>> {
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
  const psets = extractPropertiesOnDemand(store, vector.wallId);
  expect(psets).toHaveLength(1);
  return new Map(psets[0].properties.map(p => [p.name, String(p.value)]));
}

describe('IfcComplexProperty member budget (#7675)', () => {
  it('matches the server value for every case in the shared vector', async () => {
    const values = await budgetValues();
    for (const c of vector.cases) {
      const value = values.get(c.property);
      expect(value, c.property).toBeDefined();
      if (c.value !== undefined) {
        expect(value, c.property).toBe(c.value);
      } else {
        expect(value!.endsWith(c.suffix!), c.property).toBe(true);
        const digest = createHash('sha256').update(value!, 'utf8').digest('hex');
        expect([Buffer.byteLength(value!, 'utf8'), digest], c.property).toEqual([c.length, c.sha256]);
      }
    }
  });
});
