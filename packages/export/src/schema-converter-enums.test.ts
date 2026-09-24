/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5365 (charter split from #5202 finding 1): schema conversion never read an
 * enum VALUE, so a member the target schema does not define rode through into
 * a file declaring that schema. The two executed examples from #5202 are the
 * first two cases here.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { convertStepLine } from './schema-converter.js';
import { StepExporter } from './step-exporter.js';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

/** Through `StepExporter`, the seam every export uses; returns the line for `#id` and the warnings. */
async function exportRecord(record: string, from: Schema, to: Schema) {
  const header = from === 'IFC4X3' ? 'IFC4X3_ADD2' : from;
  const model = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${header}'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'P',$,$,$,$,$,$);\n${record}\nENDSEC;\nEND-ISO-10303-21;`;
  const bytes = new TextEncoder().encode(model);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const result = new StepExporter(store).export({ schema: to });
  const id = record.slice(0, record.indexOf('='));
  const line = new TextDecoder().decode(result.content).split('\n').find((l) => l.startsWith(`${id}=`)) ?? '';
  return { line, warnings: result.stats.warnings.filter((w) => w.includes('#5365')) };
}

describe('schema conversion reconciles enum members the target lacks (#5365)', () => {
  it('IFC4X3 -> IFC4: .TURNSTILE. becomes .USERDEFINED. with the name kept in ElementType', async () => {
    const { line, warnings } = await exportRecord(
      "#20=IFCDOORTYPE('1a2B3c4D5e6F7g8H9i0J1k',$,'Turnstile',$,$,$,$,$,$,.TURNSTILE.,.SINGLE_SWING_LEFT.,.T.,$);",
      'IFC4X3', 'IFC4',
    );
    expect(line).toBe("#20=IFCDOORTYPE('1a2B3c4D5e6F7g8H9i0J1k',$,'Turnstile',$,$,$,$,$,'TURNSTILE',.USERDEFINED.,.SINGLE_SWING_LEFT.,.T.,$);");
    expect(warnings).toEqual([]);
  });

  it('IFC4 -> IFC2X3: .LOUVRE. becomes .USERDEFINED. with the name kept in ElementType', async () => {
    const { line } = await exportRecord("#30=IFCAIRTERMINALTYPE('1a2B3c4D5e6F7g8H9i0J1k',$,'AT',$,$,$,$,$,$,.LOUVRE.);", 'IFC4', 'IFC2X3');
    expect(line).toContain("'LOUVRE',.USERDEFINED.");
    expect(line).not.toContain('.LOUVRE.');
  });

  it('an occurrence keeps the member name in ObjectType', async () => {
    const { line } = await exportRecord("#40=IFCDOOR('1a2B3c4D5e6F7g8H9i0J1k',$,'D',$,$,$,$,$,$,$,.TURNSTILE.,$,$);", 'IFC4X3', 'IFC4');
    expect(line).toBe("#40=IFCDOOR('1a2B3c4D5e6F7g8H9i0J1k',$,'D',$,'TURNSTILE',$,$,$,$,$,.USERDEFINED.,$,$);");
  });

  it('reports the loss when the label slot is already taken', async () => {
    const { line, warnings } = await exportRecord("#41=IFCDOOR('1a2B3c4D5e6F7g8H9i0J1k',$,'D',$,'Gate',$,$,$,$,$,.TURNSTILE.,$,$);", 'IFC4X3', 'IFC4');
    expect(line).toContain("'Gate',$,$,$,$,$,.USERDEFINED.");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('IFCDOOR.PredefinedType .TURNSTILE.');
  });

  it('a member the target defines is left alone', async () => {
    const record = "#50=IFCDOOR('1a2B3c4D5e6F7g8H9i0J1k',$,'D',$,$,$,$,$,$,$,.DOOR.,$,$);";
    expect(await exportRecord(record, 'IFC4X3', 'IFC4')).toEqual({ line: record, warnings: [] });
  });

  it('convertStepLine without a reconciliation object is unchanged (callers opt in)', () => {
    const line = "#20=IFCDOORTYPE('1a2B3c4D5e6F7g8H9i0J1k',$,'Turnstile',$,$,$,$,$,$,.TURNSTILE.,.SINGLE_SWING_LEFT.,.T.,$);";
    expect(convertStepLine(line, 'IFC4X3', 'IFC4')).toContain('.TURNSTILE.');
  });
});
