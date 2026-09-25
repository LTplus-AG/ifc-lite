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

import { describe, expect, it } from 'vitest';
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

interface Case {
  name: string;
  why: string;
  source: string;
  schema?: StepExportOptions['schema'];
  log: { mutations: unknown[]; newEntities?: NewEntity[]; georefMutations?: StepExportOptions['georefMutations'] };
  expected: string[];
}

// NOT guarded by existsSync: a missing fixture means the pin is not enforced.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/step_log_parity_vectors.json', import.meta.url),
);
const fixture: { timeStamp: string; sources: Record<string, string[]>; cases: Case[] } = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
);

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
});
