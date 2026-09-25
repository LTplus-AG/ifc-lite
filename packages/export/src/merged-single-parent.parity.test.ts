/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the merged one-decomposition-parent parity pin (#5471,
 * #5726, #5725; Rust #5727, #5802). The Rust half is
 * `rust/export/tests/merged_single_parent_parity.rs`; both read
 * `rust/export/tests/fixtures/merged_single_parent_vectors.json`, whose
 * expectations come from IFC's `Decomposes` / `Nests : SET [0:1]`, not from
 * either exporter's output. The fixture's `about` documents each field.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';

interface Case {
  name: string;
  schema?: 'IFC2X3' | 'IFC4';
  outputSchema?: 'IFC2X3' | 'IFC4';
  rels?: string[];
  options?: { dropEmptyContainers?: boolean; mergeSites?: 'by-name' };
  models: string[][];
  parents: Record<string, string[]>;
  absent?: string[];
}

// NOT guarded by existsSync: a missing fixture means the pin is not enforced.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/merged_single_parent_vectors.json', import.meta.url),
);
const cases: Case[] = JSON.parse(readFileSync(fixturePath, 'utf8')).cases;

async function model(id: string, lines: string[], schema: string): Promise<MergeModelInput> {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
  return { id, name: id, dataStore };
}

/** Top-level arguments of one entity line (the vectors carry no commas in strings). */
function args(line: string): string[] {
  const body = line.slice(line.indexOf('(') + 1, line.lastIndexOf(')'));
  const out: string[] = [];
  let [depth, start] = [0, 0];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (body[i] === ',' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out;
}

const ids = (arg: string) => [...arg.matchAll(/#(\d+)/g)].map(m => Number(m[1]));

describe('merged one-decomposition-parent parity vectors (#5471, #5727, #5802)', () => {
  it('has cases', () => expect(cases.length).toBeGreaterThan(0));

  for (const c of cases) {
    it(c.name, async () => {
      const schema = c.schema ?? 'IFC4';
      const relTypes = c.rels ?? ['IFCRELAGGREGATES'];
      const inputs = await Promise.all(c.models.map((lines, i) => model(String(i), lines, schema)));
      const out = new TextDecoder().decode(new MergedExporter(inputs).export({ schema: c.outputSchema ?? schema, ...c.options }).content);
      const guidOf = new Map<number, string>();
      for (const m of out.matchAll(/^#(\d+)=\w+\('([^']*)'/gm)) guidOf.set(Number(m[1]), m[2]);
      const parents = new Map<string, string[]>();
      const filled = new Map<number, number>();
      const count = (id: number) => filled.set(id, (filled.get(id) ?? 0) + 1);
      for (const line of out.split('\n').filter(l => relTypes.some(t => l.includes(`=${t}(`)))) {
        const a = args(line);
        // The list is whichever of arguments 4 and 5 is parenthesised.
        const [single, list] = a[5].startsWith('(') ? [ids(a[4])[0], ids(a[5])] : [ids(a[5])[0], ids(a[4])];
        for (const id of list) {
          count(id);
          const child = guidOf.get(id)!;
          parents.set(child, [...(parents.get(child) ?? []), guidOf.get(single)!]);
        }
      }
      expect([...filled].filter(([, n]) => n > 1), 'objects with two parents').toEqual([]);
      for (const [child, want] of Object.entries(c.parents)) {
        expect([...(parents.get(child) ?? [])].sort(), `parents of ${child}`).toEqual(want);
      }
      for (const guid of c.absent ?? []) expect(out, `${guid} is not written`).not.toContain(guid);
    });
  }
});
