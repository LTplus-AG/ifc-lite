/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { validateStepText } from '../src/index.js';

const file = (body: string) => `ISO-10303-21; HEADER;
FILE_DESCRIPTION(('ENDSEC; DATA; FILE_SCHEMA((''IFC2X3''))'),'2;1');
/* FILE_SCHEMA(('IFC2X3')); ENDSEC; DATA; */
FILE_NAME('a','b',('c'),('d'),'e','f','g');
FILE_SCHEMA(('IFC4')); ENDSEC; DATA; ${body} ENDSEC; END-ISO-10303-21;`;

it('reads real section boundaries and reports trailing tokens (#11560)', async () => {
  const report = await validateStepText(file("/* ENDSEC; */ #1=IFCPERSON($,$,'ENDSEC;', $,$,$,$,$); #2=IFCCARTESIANPOINT((0.,1.)) junk;"));
  expect(report.schema).toBe('IFC4_ADD2_TC1');
  expect(report.stats.instances).toBe(2);
  expect(report.findings.filter(f => f.rule === 'record-syntax').map(f => f.instance)).toEqual([2]);
});

it('enforces OF UNIQUE on references by instance identity (#11560)', async () => {
  const points = '#1=IFCCARTESIANPOINT((0.,0.)); #2=IFCCARTESIANPOINT((1.,0.)); #3=IFCCARTESIANPOINT((0.,1.));';
  const report = await validateStepText(file(points + '#4=IFCPOLYLOOP((#1,#2,#1)); #5=IFCPOLYLOOP((#1,#2,#3));'));
  expect(report.findings.some(f => f.instance === 4 && f.attribute?.includes('Polygon'))).toBe(true);
  expect(report.findings.filter(f => f.instance === 5)).toEqual([]);
});

it('checks the decoded character count of FILE_NAME.name at the 256-character boundary (#11647)', async () => {
  for (const length of [256, 257]) {
    const source = file('').replace("FILE_NAME('a'", "FILE_NAME('" + 'a'.repeat(length) + "'");
    const report = await validateStepText(source);
    expect(report.findings.filter(f => f.rule === 'FILE_NAME.name')).toHaveLength(length === 256 ? 0 : 1);
  }
});

it('reports duplicate DATA identifiers and keeps the first record (#11647)', async () => {
  const report = await validateStepText(file('#1=IFCUNKNOWN();#1=IFCCARTESIANPOINT((0.,0.));'));
  expect(report.findings.filter(f => f.instance === 1).map(f => f.rule)).toEqual(expect.arrayContaining(['duplicate-id','unknown-entity']));
});

it('validates the actual columnar parser result (#11647)', async () => {
  const { IfcParser } = await import('@ifc-lite/parser');
  const { validateDataStore } = await import('../src/index.js');
  const text = file('#1=IFCCARTESIANPOINT((0.,1.));');
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  const report = await validateDataStore(store);
  expect(report.stats.instances).toBe(1);
  expect(report.findings).toEqual((await validateStepText(text)).findings);
});

it('uses the first physical record for duplicate IDs through both entry points (#11647)', async () => {
  const { IfcParser } = await import('@ifc-lite/parser');
  const { validateDataStore } = await import('../src/index.js');
  const records = ['#7=IFCCARTESIANPOINT((0.,1.));', '#7=IFCCARTESIANPOINT(());'];
  for (const body of [records.join(''), records.reverse().join('')]) {
    const text = file(body);
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
    const direct = await validateStepText(text), parsed = await validateDataStore(store);
    expect(parsed.stats.instances).toBe(1);
    expect(parsed.findings).toEqual(direct.findings);
    expect(parsed.findings.filter(f => f.rule === 'duplicate-id').map(f => f.instance)).toEqual([7]);
  }
});

it('reads complete long HEADER records from an actual parsed store (#11647)', async () => {
  const { IfcParser } = await import('@ifc-lite/parser');
  const { validateDataStore } = await import('../src/index.js');
  const authors = Array(400).fill("'" + 'a'.repeat(175) + ";ENDSEC;'").join(',');
  for (const name of ['valid', 'x'.repeat(257)]) {
    const text = file('#1=IFCCARTESIANPOINT((0.,1.));').replace("'a','b',('c')", `'${name}','b',(${authors})`);
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
    const direct = await validateStepText(text);
    expect(direct.findings.map(f => f.rule)).toEqual(name === 'valid' ? [] : ['FILE_NAME.name']);
    expect((await validateDataStore(store)).findings).toEqual(direct.findings);
  }
});

it('includes malformed DATA statements in the validation report (#11647)', async () => {
  const bad = await validateStepText(file('#1=; nonsense; #2=IFCCARTESIANPOINT((0.,0.));'));
  expect(bad.valid).toBe(false);
  expect(bad.stats.instances).toBe(2);
  expect(bad.findings.filter(f => f.rule === 'record-syntax').map(f => f.instance)).toEqual([undefined,1]);
  expect((await validateStepText(file('#1 /* comment */ = IFCCARTESIANPOINT((0.,0.));'))).valid).toBe(true);
});
