/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the merged one-aggregation-parent parity pin (#5471,
 * #5727). The Rust half is `rust/export/tests/merged_single_parent_parity.rs`;
 * both read `rust/export/tests/fixtures/merged_single_parent_vectors.json`,
 * whose expectations come from IFC's `Decomposes : SET [0:1]`, not from
 * either exporter's output.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';

interface Case {
  name: string;
  models: string[][];
  parents: Record<string, string[]>;
}

// NOT guarded by existsSync: a missing fixture means the pin is not enforced.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/merged_single_parent_vectors.json', import.meta.url),
);
const cases: Case[] = JSON.parse(readFileSync(fixturePath, 'utf8')).cases;

async function model(id: string, lines: string[]): Promise<MergeModelInput> {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
  return { id, name: id, dataStore };
}

describe('merged one-aggregation-parent parity vectors (#5471, #5727)', () => {
  it('has cases', () => expect(cases.length).toBeGreaterThan(0));

  for (const c of cases) {
    it(c.name, async () => {
      const inputs = await Promise.all(c.models.map((lines, i) => model(String(i), lines)));
      const out = new TextDecoder().decode(new MergedExporter(inputs).export({ schema: 'IFC4' }).content);
      const guidOf = new Map<number, string>();
      for (const m of out.matchAll(/^#(\d+)=\w+\('([^']*)'/gm)) guidOf.set(Number(m[1]), m[2]);
      const parents = new Map<string, string[]>();
      const membership = new Map<number, number>();
      for (const m of out.matchAll(/^#\d+=IFCRELAGGREGATES\(.*,#(\d+),\(([^)]*)\)\);$/gm)) {
        for (const r of m[2].matchAll(/#(\d+)/g)) {
          const id = Number(r[1]);
          membership.set(id, (membership.get(id) ?? 0) + 1);
          const child = guidOf.get(id)!;
          parents.set(child, [...(parents.get(child) ?? []), guidOf.get(Number(m[1]))!]);
        }
      }
      expect([...membership].filter(([, n]) => n > 1), 'objects with two parents').toEqual([]);
      for (const [child, want] of Object.entries(c.parents)) {
        expect([...(parents.get(child) ?? [])].sort(), `parents of ${child}`).toEqual(want);
      }
    });
  }
});
