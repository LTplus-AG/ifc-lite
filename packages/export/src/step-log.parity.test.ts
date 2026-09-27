/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the mutation-log STEP parity pin (#5941). The Rust half is
 * `rust/export/tests/step_log_parity.rs` (`ifc_lite_export::export_step_with_log`);
 * both read `rust/export/tests/fixtures/step_log_parity_vectors.json`.
 *
 * This half checks that the fixture's `expected` files ARE what `StepExporter`
 * writes for each log, replayed the way a host replays one: `importMutations`
 * into a `MutablePropertyView` wired like the viewer's
 * (`apps/viewer/src/utils/configureMutationView.ts`). The Rust half checks its
 * writer produces the same bytes. A change to this exporter's output fails here
 * first, and the fixture must be regenerated from this exporter, not edited to
 * match either side.
 *
 * Generated GlobalIds are the one difference by design: this exporter draws
 * them at random, the Rust writer derives them. Both halves replace the GlobalId
 * of every record above the source's highest express id with `<GUID>`.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  IfcParser,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypeEntityOwnProperties,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { MutablePropertyView, type NewEntity } from '@ifc-lite/mutations';
import { StepExporter, type StepExportOptions } from './step-exporter.js';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';

interface Case {
  name: string;
  why: string;
  source: string;
  schema?: StepExportOptions['schema'];
  log: { mutations: unknown[]; newEntities?: NewEntity[]; georefMutations?: StepExportOptions['georefMutations'] };
  expected: string[];
}

interface MergedCase {
  name: string;
  why: string;
  schema?: StepExportOptions['schema'];
  models: Array<{ source: string; log: Case['log'] }>;
  expected: string[];
}

// NOT guarded by existsSync: a missing fixture means the pin is not enforced.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/step_log_parity_vectors.json', import.meta.url),
);
interface RefusedCase {
  name: string;
  why: string;
  source: string;
  skipped: number;
  error: string;
  log: Case['log'];
}

const fixture: {
  timeStamp: string;
  sources: Record<string, string[]>;
  cases: Case[];
  mergedCases: MergedCase[];
  refusedCases: RefusedCase[];
} = JSON.parse(readFileSync(fixturePath, 'utf8'));

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
}

/** The viewer's wiring: a type object's base is its own sets. */
function configure(view: MutablePropertyView, store: IfcDataStore): void {
  view.setOnDemandExtractor((id: number) => {
    const typeName = store.entities?.getTypeName(id) ?? '';
    if (typeName.endsWith('Type')) return extractTypeEntityOwnProperties(store, id);
    return extractPropertiesOnDemand(store, id);
  });
  view.setQuantityExtractor((id: number) => extractQuantitiesOnDemand(store, id));
}

function normalise(lines: string[], maxId: number): string[] {
  return lines.map((line) => {
    const m = /^#(\d+)=IFC\w+\('([0-9A-Za-z_$]{22})'/.exec(line);
    return m && Number(m[1]) > maxId ? line.replace(m[2], '<GUID>') : line;
  });
}

describe('mutation-log STEP export parity with the Rust writer (#5941)', () => {
  it('carries cases', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    it(c.name, async () => {
      const source = fixture.sources[c.source];
      const text = `${source.join('\n')}\n`;
      const maxId = Math.max(...source.map((l) => Number(/^#(\d+)=/.exec(l)?.[1] ?? 0)));
      const store = await parse(text);
      const view = new MutablePropertyView(null, 'model');
      configure(view, store);
      for (const entity of c.log.newEntities ?? []) view.restoreNewEntity(entity);
      view.importMutations(JSON.stringify(c.log));
      const result = new StepExporter(store, view).export({
        schema: c.schema ?? (store.schemaVersion as StepExportOptions['schema']) ?? 'IFC4',
        timeStamp: fixture.timeStamp,
        ...(c.log.georefMutations ? { georefMutations: c.log.georefMutations } : {}),
      });
      const lines = new TextDecoder().decode(result.content).split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      expect(normalise(lines, maxId)).toEqual(c.expected);
    });
  }

  // A merged export bakes each edited model through `StepExporter` first
  // (`bakeMutatedModels`); the Rust half does the same with its writer. The
  // two merged headers differ outside this issue's scope (the TypeScript one
  // stamps the wall clock), so the DATA section is what is pinned.
  const knownGuids = new Set(
    Object.values(fixture.sources).flatMap((lines) =>
      lines.flatMap((l) => [...l.matchAll(/'([0-9A-Za-z_$]{22})'/g)].map((m) => m[1])),
    ),
  );
  for (const c of fixture.mergedCases) {
    it(`merged: ${c.name}`, async () => {
      const inputs: MergeModelInput[] = [];
      for (const [i, m] of c.models.entries()) {
        const store = await parse(`${fixture.sources[m.source].join('\n')}\n`);
        const view = new MutablePropertyView(null, 'model');
        configure(view, store);
        for (const entity of m.log.newEntities ?? []) view.restoreNewEntity(entity);
        view.importMutations(JSON.stringify(m.log));
        inputs.push({ id: `m${i}`, name: `m${i}`, dataStore: store, mutationView: view });
      }
      const result = await new MergedExporter(inputs).exportAsync({ schema: c.schema ?? 'IFC4' });
      const text = new TextDecoder().decode(result.content);
      const lines = text.slice(text.indexOf('DATA;\n')).split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const normalised = lines.map((l) => {
        const m = /^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})'/.exec(l);
        return m && !knownGuids.has(m[1]) ? l.replace(m[1], '<GUID>') : l;
      });
      expect(normalised).toEqual(c.expected);
    });
  }

  // The Rust writer refuses these logs (`step_log_refusals.rs`,
  // `logs_the_typescript_replay_would_save_without_an_edit_are_refused`). What
  // pins the divergence here is the TypeScript side of it: the replay writes a
  // file that is exactly the file for the log WITHOUT the skipped record, so an
  // edit the caller sent is missing and nothing in the file says so.
  const exportLog = async (source: string, log: Case['log']): Promise<string> => {
    const store = await parse(`${fixture.sources[source].join('\n')}\n`);
    const view = new MutablePropertyView(null, 'model');
    configure(view, store);
    view.importMutations(JSON.stringify(log));
    const result = new StepExporter(store, view).export({ schema: 'IFC4', timeStamp: fixture.timeStamp });
    return new TextDecoder().decode(result.content);
  };
  for (const c of fixture.refusedCases) {
    it(`refused by the Rust writer, skipped by the replay: ${c.name}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const withRecord = await exportLog(c.source, c.log);
        const without = await exportLog(c.source, {
          ...c.log,
          mutations: c.log.mutations.filter((_, i) => i !== c.skipped),
        });
        expect(withRecord).toBe(without);
      } finally {
        warn.mockRestore();
      }
    });
  }
});
