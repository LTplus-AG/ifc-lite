/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4686: IfcRoot.OwnerHistory is optional in IFC4 and mandatory in IFC2X3, and
 * a downgrade used to keep the source's `$` there. The shared vectors run
 * through `StepExporter` here and through the Rust `export_step` in
 * `rust/export/src/schema_convert_tests.rs`; the merged exporter and an
 * overlay-created record are pinned below because they reach
 * `convertStepLine` from their own call sites.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { MergedExporter } from './merged-exporter.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';

interface Vector {
  why: string;
  schema: string;
  data: string[];
  owner_history: Record<string, string>;
  unfilled: number;
}

const vectors: Vector[] = JSON.parse(
  readFileSync(new URL('../../../rust/export/tests/fixtures/ifc2x3_owner_history_vectors.json', import.meta.url), 'utf8'),
).cases;

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

function stepFile(schema: string, data: string[]): string {
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('a.ifc','',(''),(''),'','','');", `FILE_SCHEMA(('${schema}'));`, 'ENDSEC;',
    'DATA;', ...data, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
}

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
}

function lineWithId(out: string, id: string): string {
  const line = out.split('\n').find((l) => l.startsWith(`${id}=`));
  if (line === undefined) throw new Error(`${id} not in\n${out}`);
  return line;
}

function slot(line: string, index: number): string | undefined {
  return splitTopLevelStepArguments(line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')))?.[index];
}

function unfilledFrom(warnings: readonly string[]): number {
  const warning = warnings.find((w) => w.includes('keep $ in OwnerHistory'));
  return warning === undefined ? 0 : Number(warning.split(' ')[0]);
}

describe('IFC2X3 downgrade fills a $ OwnerHistory from an owner history the export writes (#4686)', () => {
  it('has the shared vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
  });

  for (const vector of vectors) {
    it(`StepExporter: ${vector.why}`, async () => {
      const store = await parse(stepFile(vector.schema, vector.data));
      const result = new StepExporter(store).export({ schema: 'IFC2X3' });
      const out = decode(result.content);
      for (const [id, want] of Object.entries(vector.owner_history)) {
        expect(slot(lineWithId(out, `#${id}`), 1), lineWithId(out, `#${id}`)).toBe(want);
      }
      expect(unfilledFrom(result.stats.warnings), out).toBe(vector.unfilled);
    });
  }

  it('fills an overlay-created record from the source owner history', async () => {
    const store = await parse(stepFile('IFC4', [
      "#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);",
      '#5=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);',
    ]));
    const view = new MutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(5);
    const created = view.createEntity('IfcBuildingElementProxy', [
      'newGUID00000000000000', '$', 'Created', '$', '$', '$', '$', '$', '.NOTDEFINED.',
    ]);
    const result = new StepExporter(store, view).export({ schema: 'IFC2X3', applyMutations: true });
    const out = decode(result.content);
    expect(slot(lineWithId(out, `#${created.expressId}`), 1), out).toBe('#5');
    expect(slot(lineWithId(out, '#1'), 1), out).toBe('#5');
    expect(unfilledFrom(result.stats.warnings)).toBe(0);
  });

  // PR #4729 review: the fallback came from the SOURCE byType index, so an
  // owner history the session retyped to another class was still chosen and
  // every `$` slot pointed at a record that is no longer an IfcOwnerHistory.
  const retypedOwnerHistories = async (retyped: number[]) => {
    const store = await parse(stepFile('IFC4', [
      "#10=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',$,'Wall',$,$,$,$,$,$);",
      '#5=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);',
      '#6=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);',
    ]));
    const view = new MutablePropertyView(null, 'm1');
    for (const id of retyped) view.setEntityType(id, 'IfcActor');
    return new StepExporter(store, view).export({ schema: 'IFC2X3', applyMutations: true });
  };

  it('skips an owner history the session retyped to another class', async () => {
    const out = decode((await retypedOwnerHistories([5])).content);
    expect(lineWithId(out, '#5'), out).toMatch(/^#5=IFCACTOR\(/);
    expect(slot(lineWithId(out, '#10'), 1), out).toBe('#6');
  });

  it('keeps $ and warns once every owner history was retyped away', async () => {
    const result = await retypedOwnerHistories([5, 6]);
    expect(slot(lineWithId(decode(result.content), '#10'), 1)).toBe('$');
    expect(unfilledFrom(result.stats.warnings)).toBeGreaterThan(0);
  });

  for (const mode of ['export', 'exportAsync'] as const) {
    it(`MergedExporter.${mode}: a model without an owner history reuses the one an earlier model wrote`, async () => {
      const a = await parse(stepFile('IFC4', [
        '#1=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);',
        "#2=IFCWALL('1abcdefghijklmnopqrstu',$,'A',$,$,$,$,$,$);",
      ]));
      const b = await parse(stepFile('IFC4', ["#1=IFCWALL('2abcdefghijklmnopqrstu',$,'B',$,$,$,$,$,$);"]));
      const run = (models: ConstructorParameters<typeof MergedExporter>[0]) => {
        const exporter = new MergedExporter(models);
        return mode === 'export' ? exporter.export({ schema: 'IFC2X3' }) : exporter.exportAsync({ schema: 'IFC2X3' });
      };
      const merged = await run([
        { id: 'a', name: 'A', dataStore: a },
        { id: 'b', name: 'B', dataStore: b },
      ]);
      const out = decode(merged.content);
      const history = out.split('\n').find((l) => l.includes('IFCOWNERHISTORY('));
      expect(history, out).toBeDefined();
      const historyRef = history!.slice(0, history!.indexOf('='));
      for (const name of ["'A'", "'B'"]) {
        const wall = out.split('\n').find((l) => l.includes(name));
        expect(wall === undefined ? undefined : slot(wall, 1), out).toBe(historyRef);
      }
      expect(unfilledFrom(merged.stats.warnings)).toBe(0);

      const alone = await run([{ id: 'b', name: 'B', dataStore: b }]);
      const wall = decode(alone.content).split('\n').find((l) => l.includes("'B'"));
      expect(wall === undefined ? undefined : slot(wall, 1)).toBe('$');
      expect(unfilledFrom(alone.stats.warnings)).toBe(1);
    });
  }
});
