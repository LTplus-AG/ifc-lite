/* SPDX-License-Identifier: MPL-2.0 */
/**
 * TypeScript half of the structural carrier parity pin (#10597): CausedBy as a
 * 'Causes' relationship, both directions. The Rust half is
 * `rust/export/tests/structural_carriers_parity.rs`; both read one fixture.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';

interface Case { why: string; from: 'IFC2X3' | 'IFC4'; to: 'IFC2X3' | 'IFC4'; data: string; expect: string[] }
const FIXTURE = fileURLToPath(new URL('../../../rust/export/tests/fixtures/structural_carriers_parity.json', import.meta.url));
const doc = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { owner: string; selectIds: number[]; selectTypes: string[]; cases: Case[] };

async function selected(c: Case): Promise<string[]> {
  const text = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('${c.from}'));\nENDSEC;\nDATA;\n${doc.owner}\n${c.data}\nENDSEC;\nEND-ISO-10303-21;\n`;
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
  const out = new TextDecoder().decode(new StepExporter(store).export({ schema: c.to }).content);
  return out.split('\n').filter((line) => {
    const record = /^#(\d+)=([A-Z0-9_]+)\(/.exec(line);
    return record !== null && (doc.selectIds.includes(Number(record[1])) || doc.selectTypes.includes(record[2]));
  });
}

describe('structural carriers parity with rust/export #10597', () => {
  it.each(doc.cases)('$from -> $to: $why', async (c) => {
    if (process.env.IFC_LITE_REPIN_PARITY) console.log('PIN', JSON.stringify(await selected(c)));
    expect(c.expect.some((line) => /^#\d+=IFCSTRUCTURAL/.test(line))).toBe(true);
    expect(await selected(c)).toEqual(c.expect);
  });
});
