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
