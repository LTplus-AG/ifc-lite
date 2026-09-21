/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4714: IFC4 made attributes optional that IFC2X3 declares mandatory, and a
 * downgrade kept the source's `$` in every one of them except `OwnerHistory`
 * (#4686). The shared vectors run through `StepExporter` here and through the
 * Rust `export_step` in `rust/export/src/schema_convert_tests.rs`; the merged
 * exporter and the public `convertStepLine` are pinned below because they
 * reach the fill from their own call sites.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { MergedExporter } from './merged-exporter.js';
import { convertStepLine } from './schema-converter.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';

interface Vector {
  why: string;
  schema: string;
  data: string[];
  slots: Record<string, Record<string, string>>;
  unfilled: number;
}

const vectors: Vector[] = JSON.parse(
  readFileSync(new URL('../../../rust/export/tests/fixtures/ifc2x3_required_slot_vectors.json', import.meta.url), 'utf8'),
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
  const warning = warnings.find((w) => w.includes('keep $ where IFC2X3 requires'));
  return warning === undefined ? 0 : Number(warning.split(' ')[0]);
}

describe('IFC2X3 downgrade settles the slots IFC2X3 requires a value in (#4714)', () => {
  it('has the shared vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
  });

  for (const vector of vectors) {
    it(`StepExporter: ${vector.why}`, async () => {
      const store = await parse(stepFile(vector.schema, vector.data));
      const result = new StepExporter(store).export({ schema: 'IFC2X3' });
      const out = decode(result.content);
      for (const [id, wantSlots] of Object.entries(vector.slots)) {
        const line = lineWithId(out, `#${id}`);
        for (const [index, want] of Object.entries(wantSlots)) {
          expect(slot(line, Number(index)), `slot ${index} of ${line}`).toBe(want);
        }
      }
      expect(unfilledFrom(result.stats.warnings), out).toBe(vector.unfilled);
    });
  }

  // The table's indexes are positions in the IFC2X3 attribute list, so a
  // record that does not carry that many slots was never reconciled to it and
  // writing into position 8 would land on whatever it does hold.
  it('refuses a record whose arity is not the one IFC2X3 declares, and counts nothing for it', async () => {
    const store = await parse(stepFile('IFC4', [
      "#10=IFCFOOTING('2O2Fr$t4X7Zf8NOew3FLOH',$,'F',$,$,$,$,$);",
      "#11=IFCFOOTING('3O2Fr$t4X7Zf8NOew3FLOH',$,'F',$,$,$,$,$,$);",
    ]));
    const result = new StepExporter(store).export({ schema: 'IFC2X3' });
    const out = decode(result.content);
    expect(lineWithId(out, '#10'), out).not.toContain('.NOTDEFINED.');
    expect(slot(lineWithId(out, '#11'), 8), out).toBe('.NOTDEFINED.');
    expect(unfilledFrom(result.stats.warnings), out).toBe(0);
  });

  // The by-name remap leaves IfcDoorStyle's four mandatory slots `$`; the fill
  // settles them from the same generated table straight afterwards, on the
  // public call as much as on the exporter path.
  it('fills the by-name remap target\'s mandatory slots with no fill passed', () => {
    const line = convertStepLine(
      "#1=IFCDOORTYPE('1abcdefghijklmnopqrstu',$,'D',$,$,$,$,$,$,.DOOR.,.SINGLE_SWING_LEFT.,$,$);",
      'IFC4',
      'IFC2X3',
    )!;
    expect(line).toContain('IFCDOORSTYLE(');
    expect(slot(line, 8)).toBe('.SINGLE_SWING_LEFT.');
    expect(slot(line, 9)).toBe('.NOTDEFINED.');
    expect(slot(line, 10)).toBe('.F.');
    expect(slot(line, 11)).toBe('.F.');
  });

  // A type that reaches the fill through no rename, so it covers the hole the
  // door case above cannot: that one passed before #4750's review round.
  it('applies the required-slot defaults in its public three-argument form', () => {
    const line = convertStepLine(
      "#10=IFCFOOTING('2O2Fr$t4X7Zf8NOew3FLOH',#5,'F',$,$,$,$,$,$);",
      'IFC4',
      'IFC2X3',
    )!;
    expect(slot(line, 8), line).toBe('.NOTDEFINED.');
    // The four-argument form takes the same branch; pinned so "both forms" in
    // the changeset is a claim a test carries rather than one a reader checks.
    const seeded = convertStepLine(
      "#10=IFCFOOTING('2O2Fr$t4X7Zf8NOew3FLOH',#5,'F',$,$,$,$,$,$);",
      'IFC4',
      'IFC2X3',
      undefined,
    )!;
    expect(slot(seeded, 8), seeded).toBe('.NOTDEFINED.');
  });

  it('leaves a target that is not IFC2X3 alone', () => {
    const line = convertStepLine(
      "#10=IFCFOOTING('2O2Fr$t4X7Zf8NOew3FLOH',$,'F',$,$,$,$,$,$);",
      'IFC2X3',
      'IFC4',
    )!;
    expect(slot(line, 8)).toBe('$');
  });

  for (const mode of ['export', 'exportAsync'] as const) {
    it(`MergedExporter.${mode}: the count reaches the caller through stats.warnings`, async () => {
      const model = await parse(stepFile('IFC4', [
        '#1=IFCOWNERHISTORY(#8,#9,$,.NOCHANGE.,$,$,$,0);',
        "#2=IFCBUILDINGSTOREY('1abcdefghijklmnopqrstu',$,'S',$,$,$,$,$,$,$);",
      ]));
      const exporter = new MergedExporter([{ id: 'a', name: 'A', dataStore: model }]);
      const merged = await (mode === 'export'
        ? exporter.export({ schema: 'IFC2X3' })
        : exporter.exportAsync({ schema: 'IFC2X3' }));
      const out = decode(merged.content);
      const storey = out.split('\n').find((l) => l.includes("'S'"));
      expect(storey === undefined ? undefined : slot(storey, 8), out).toBe('$');
      expect(unfilledFrom(merged.stats.warnings), JSON.stringify(merged.stats.warnings)).toBe(1);
    });
  }
});
