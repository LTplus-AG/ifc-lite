/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser, extractPropertiesOnDemand, type IfcDataStore } from '../src/columnar-parser.js';
import { complexPropertyOutputBudget } from '../src/property-complex-value.js';
import { complexPropertyCuts } from '../src/complex-property-store.js';

/**
 * #7675: the `IfcComplexProperty` depth cap bounds a path's LENGTH only, so a
 * member listing itself `k` times was `k^8` reads, one visit can copy a long
 * name, and every entity sharing a set walked it again. The walk is bounded by
 * member visits per property and ONE output budget per store, relative to the
 * input, mirroring `ifc_lite_core::limits`. The vector is shared with the
 * server (`complex_property_walk_budget_matches_the_shared_vector` in
 * `apps/server/src/services/data_model/tests.rs`) and the Rust exporter
 * (`rust/export/src/step_log/base_tests.rs`), so all three walks stay
 * byte-identical.
 */
interface PinnedSet {
  name: string;
  count: number;
  values?: string[];
  length?: number;
  sha256?: string;
}
/** A run of ids or lines: `{i}` in each line is replaced by `from`, `from + 1`,
 *  ... for `count` rounds, the lines in order each round. */
interface Repeat {
  from: number;
  count: number;
  repeat?: string[];
}
interface BudgetCase {
  name: string;
  dataLines: Array<string | Repeat>;
  entityIds: Array<number | Repeat>;
  psets: PinnedSet[];
  /** Levels and listings the model's budget cuts, when pinned. */
  cuts?: number;
}

function expandLines(lines: BudgetCase['dataLines']): string[] {
  return lines.flatMap(line => {
    if (typeof line === 'string') return [line];
    const out: string[] = [];
    for (let i = line.from; i < line.from + line.count; i++) {
      for (const template of line.repeat ?? []) out.push(template.replaceAll('{i}', String(i)));
    }
    return out;
  });
}

function expandIds(ids: BudgetCase['entityIds']): number[] {
  return ids.flatMap(id => (typeof id === 'number' ? [id] : Array.from({ length: id.count }, (_, k) => id.from + k)));
}

const vector: { cases: BudgetCase[] } = JSON.parse(
  readFileSync(new URL('./fixtures/complex-property-budget-7675.json', import.meta.url), 'utf8')
);

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

const valuesOf = (set: { properties: Array<{ value: unknown }> }): string[] =>
  set.properties.map(p => (p.value == null ? '' : String(p.value)));

describe('IfcComplexProperty walk budget (#7675)', () => {
  for (const c of vector.cases) {
    it(`${c.name}: every entity matches the server and the exporter`, async () => {
      const text = expandLines(c.dataLines).join('\n');
      const store = await parse(text);
      const budget = complexPropertyOutputBudget(Buffer.byteLength(text, 'utf8'));
      for (const entityId of expandIds(c.entityIds)) {
        const sets = extractPropertiesOnDemand(store, entityId);
        const total = sets.reduce((n, s) => n + valuesOf(s).reduce((m, v) => m + Buffer.byteLength(v, 'utf8'), 0), 0);
        expect(total, `#${entityId} value bytes`).toBeLessThanOrEqual(budget);
        expect(sets.map(s => s.name), `#${entityId}`).toEqual(c.psets.map(p => p.name));
        for (const expected of c.psets) {
          const values = valuesOf(sets.find(s => s.name === expected.name)!);
          expect(values.length, expected.name).toBe(expected.count);
          const joined = values.join('\n');
          if (expected.values) expect(values, expected.name).toEqual(expected.values);
          else {
            const digest = createHash('sha256').update(joined, 'utf8').digest('hex');
            expect([Buffer.byteLength(joined, 'utf8'), digest], expected.name).toEqual([expected.length, expected.sha256]);
          }
        }
      }
      if (c.cuts !== undefined) expect(complexPropertyCuts(store), 'cuts').toBe(c.cuts);
    });
  }
});
