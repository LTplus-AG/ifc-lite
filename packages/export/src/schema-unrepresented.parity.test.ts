/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the "no representation in the target schema" pin (#7742).
 * The Rust half is `rust/export/tests/schema_unrepresented_parity.rs`; both run
 * `rust/export/tests/fixtures/schema_unrepresented_vectors.json`. Before #7742
 * the Rust converter wrote IFC4X3-only resource records into an IFC4 file that
 * this one refuses.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { MergedExporter } from './merged-exporter.js';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';

interface Case {
  why: string;
  from: IfcSchemaVersion;
  to: IfcSchemaVersion;
  line: string;
  expect?: string;
  refuses?: boolean;
  merge?: boolean;
}

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_unrepresented_vectors.json', import.meta.url)),
    'utf8',
  ),
);

describe('convertStepLine matches the shared unrepresented-type vectors (#7742)', () => {
  it('the fixture is not trivial', () => {
    expect(fixture.cases.filter((c) => c.refuses).length).toBeGreaterThanOrEqual(8);
    expect(fixture.cases.some((c) => !c.refuses)).toBe(true);
  });

  // Compact and spaced (`#5 = TYPE (`, as Viadotto_Acerno writes): the spaced
  // form used to miss the record regex and pass through unconverted (#7742).
  const spaced = (line: string) => line.replace(/^(#\d+)=(\w+)\(/, '$1 = $2 (');
  for (const c of fixture.cases) {
    for (const line of [c.line, spaced(c.line)]) {
      it(`${c.from} -> ${c.to}: ${c.why} [${line === c.line ? 'compact' : 'spaced'}]`, () => {
        expect(line === c.line || line.startsWith('#5 = ')).toBe(true);
        if (c.refuses) {
          expect(() => convertStepLine(line, c.from, c.to)).toThrow(/no representation/);
          return;
        }
        expect(convertStepLine(line, c.from, c.to)).toBe(c.expect);
      });
    }
  }
});

function parseModel(schema: IfcSchemaVersion, line: string) {
  const step = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${line}\nENDSEC;\nEND-ISO-10303-21;\n`;
  return new IfcParser().parseColumnar(new TextEncoder().encode(step).buffer);
}

it.each(fixture.cases.filter((c) => c.merge))('keeps two distinct proxy IDs when merging copies: $why', async (c) => {
  const dataStore = await parseModel(c.from, c.line);
  const models = ['a', 'b'].map((id) => ({ id, name: id, dataStore }));
  const merged = new TextDecoder().decode(new MergedExporter(models).export({ schema: c.to }).content);
  const ids = [...merged.matchAll(/^#\d+=IFCPROXY\('([0-3][0-9A-Za-z_$]{21})',/gm)].map((m) => m[1]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  expect(c.expect).toContain(`IFCPROXY('${ids[0]}'`);
});

it.each(['IFC4', 'IFC2X3'] as const)('unifies native IFC4 proxies by GlobalId when exporting to %s (#11322)', async (to) => {
  const guid = '0YvctVUKr0kugbFTf53O9L';
  const models = await Promise.all(['First', 'Second'].map(async (id) => ({
    id, name: id, dataStore: await parseModel('IFC4', `#5=IFCPROXY('${guid}',$,'${id}',$,$,$,$,.NOTDEFINED.,$);`),
  })));
  const out = new TextDecoder().decode(new MergedExporter(models).export({ schema: to }).content);
  const proxies = [...out.matchAll(/^#\d+=IFCPROXY\('([^']+)',[^,]*,'([^']+)'/gm)];
  expect(proxies.map(([, globalId, name]) => [globalId, name])).toEqual([[guid, 'First']]);
});

it('re-stamps a collision with a generated proxy GlobalId (#11322)', async () => {
  const guid = '3lJWJ4oIi38uI5nMw7H8hx';
  const proxy = await parseModel('IFC4X3', '#5=IFCRELPOSITIONS($,$,/* unnamed */$,$,#1,(#2));');
  const wall = await parseModel('IFC4', `#1=IFCWALL('${guid}',$,'Wall',$,$,$,$,$,.NOTDEFINED.);`);
  const out = new TextDecoder().decode(new MergedExporter([
    { id: 'proxy', name: 'proxy', dataStore: proxy }, { id: 'wall', name: 'wall', dataStore: wall },
  ]).export({ schema: 'IFC4' }).content);
  const ids = [...out.matchAll(/^#\d+=(?:IFCPROXY|IFCWALL)\('([^']+)'/gm)].map((m) => m[1]);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(guid);
  expect(ids[1]).not.toBe(guid);
});

it.each(['proxy', 'wall'] as const)('keeps the proxy and wall that share a GlobalId, %s first (#11322)', async (first) => {
  const guid = '0YvctVUKr0kugbFTf53O9L';
  const [proxy, wall] = await Promise.all([
    parseModel('IFC4X3', `#5=IFCRELPOSITIONS('${guid}',$,'R',$,#1,(#2));`),
    parseModel('IFC4', `#1=IFCWALL('${guid}',$,'Wall',$,$,$,$,$,.NOTDEFINED.);`),
  ]);
  const models = [{ id: 'proxy', name: 'proxy', dataStore: proxy }, { id: 'wall', name: 'wall', dataStore: wall }];
  if (first === 'wall') models.reverse();
  const merged = new TextDecoder().decode(new MergedExporter(models).export({ schema: 'IFC4' }).content);
  const roots = [...merged.matchAll(/^#\d+=(IFCPROXY|IFCWALL)\('([0-3][0-9A-Za-z_$]{21})',/gm)];
  expect(roots.map((m) => m[1])).toEqual(first === 'proxy' ? ['IFCPROXY', 'IFCWALL'] : ['IFCWALL', 'IFCPROXY']);
  expect(roots[0][2]).toBe(guid);
  expect(roots[1][2]).not.toBe(guid);
});

it.each([
  ['IFC4', 'IFC2X3', 'IFCSTRUCTURALCURVEREACTION', false, 'wall'],
  ['IFC4', 'IFC2X3', 'IFCSTRUCTURALCURVEREACTION', false, 'proxy'],
  ['IFC4X3', 'IFC4', 'IFCALIGNMENTSEGMENT', true, 'wall'],
  ['IFC4X3', 'IFC4', 'IFCALIGNMENTSEGMENT', true, 'proxy'],
] as const)('keeps %s → %s %s and wall distinct (minted proxy: %s, %s first) (#11322)', async (from, to, type, mintedProxy, first) => {
  const guid = '0YvctVUKr0kugbFTf53O9L';
  const attributes = mintedProxy ? "$,'Segment',$,$,$,$,#2" : "$,'Reaction',$,$,$,$,#2,.GLOBAL_COORDS.,.DISCRETE.";
  const [proxy, wall] = await Promise.all([
    parseModel(from, `#5=${type}('${guid}',${attributes});`),
    parseModel(from, `#1=IFCWALL('${guid}',$,'Wall',$,$,$,$,$,.NOTDEFINED.);`),
  ]);
  const models = [{ id: 'proxy', name: 'proxy', dataStore: proxy }, { id: 'wall', name: 'wall', dataStore: wall }];
  if (first === 'wall') models.reverse();
  const out = new TextDecoder().decode(new MergedExporter(models).export({ schema: to }).content);
  const roots = [...out.matchAll(/^#\d+=(IFCPROXY|IFCWALL)\('([0-3][0-9A-Za-z_$]{21})',/gm)];
  expect(roots.map((m) => m[1])).toEqual(first === 'wall' ? ['IFCWALL', 'IFCPROXY'] : ['IFCPROXY', 'IFCWALL']);
  const expected = mintedProxy
    ? first === 'wall' ? [guid, '2r5SrPtCIW9JYNjX1BW7dv'] : ['1tUrwBAVKXXziaSy8PtiVv', guid]
    : first === 'wall' ? [guid, '10eAHYqx8ewhIsCT7yemIL'] : [guid, '0tr9wqYqpdsHHEufgQ1Tzr'];
  expect(roots.map((m) => m[2])).toEqual(expected);
});
