/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10544 on real parsed models (IfcParser + createDataAccessor + validateIDS).
 *
 * An entity name given as a pattern or an enumeration used to be matched
 * regardless of case, against the PascalCase class (`IfcWall`). IDS 1.0
 * names the class in upper case, and IfcTester matches a pattern or an
 * enumeration against the upper-case class, case-sensitively. So
 * `IfcDistribution.*Element` selected elements here and none there.
 *
 * A wall, a slab, a distribution chamber and a flow terminal typed by an air
 * terminal type, all named and contained in a storey, written as IFC2X3,
 * IFC4 and IFC4X3_ADD2. Each specification selects elements and requires a
 * Name, which each has, so `applicable` is what the entity name selects.
 * The expected rows are IfcTester's on the same text (ifctester 0.8.3 on
 * IfcOpenShell 0.8.4, `ids.open(..., validate=True)`), except two kinds of
 * rows marked below, where IFC Lite follows buildingSMART rather than
 * IfcTester and this change leaves them as they were.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { createDataAccessor } from '../bridge/index.js';
import { validateIDS } from '../validation/validator.js';
import { checkEntityFacet, entityFacetPasses } from './entity-facet.js';
import { createMockAccessor } from './test-helpers.js';
import type { IDSConstraint, IDSEntityFacet, IFCDataAccessor } from '../types.js';

const gid = (n: number) => String(n).padStart(22, '0');

function step(schema: string): string {
  const pt = (token: string) => (schema === 'IFC2X3' ? '' : `,${token}`);
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('entity-pattern-case.ifc','2026-11-16T00:00:00',(''),(''),'','','');",
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;',
    'DATA;',
    `#1=IFCPROJECT('${gid(1)}',$,'Project',$,$,$,$,$,#3);`,
    '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    '#3=IFCUNITASSIGNMENT((#2));',
    `#5=IFCBUILDINGSTOREY('${gid(5)}',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);`,
    `#10=IFCWALL('${gid(10)}',$,'W-1',$,$,$,$,$${pt('.SOLIDWALL.')});`,
    `#11=IFCSLAB('${gid(11)}',$,'S-1',$,$,$,$,$,.FLOOR.);`,
    `#12=IFCDISTRIBUTIONCHAMBERELEMENT('${gid(12)}',$,'C-1',$,$,$,$,$${pt('.MANHOLE.')});`,
    `#13=IFCFLOWTERMINAL('${gid(13)}',$,'F-1',$,$,$,$,$);`,
    `#14=IFCAIRTERMINALTYPE('${gid(14)}',$,'AT',$,$,$,$,$,$,.GRILLE.);`,
    `#15=IFCRELDEFINESBYTYPE('${gid(15)}',$,$,$,(#13),#14);`,
    `#16=IFCRELCONTAINEDINSPATIALSTRUCTURE('${gid(16)}',$,$,$,(#10,#11,#12,#13),#5);`,
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');
}

const simple = (v: string) => `<simpleValue>${v}</simpleValue>`;
const pattern = (p: string) => `<xs:restriction base="xs:string"><xs:pattern value="${p}"/></xs:restriction>`;
const list = (...v: string[]) =>
  `<xs:restriction base="xs:string">${v.map((x) => `<xs:enumeration value="${x}"/>`).join('')}</xs:restriction>`;
const entity = (name: string) => `<entity><name>${name}</name></entity>`;
const partOf = (name: string) =>
  `<entity><name>${pattern('IFC.*')}</name></entity><partOf relation="IFCRELCONTAINEDINSPATIALSTRUCTURE"><entity><name>${name}</name></entity></partOf>`;

function ids(schema: string, specs: Array<[string, string]>): string {
  const body = specs
    .map(
      ([name, facets]) => `
    <specification name="${name}" ifcVersion="${schema}">
      <applicability minOccurs="0" maxOccurs="unbounded">${facets}</applicability>
      <requirements><attribute><name>${simple('Name')}</name></attribute></requirements>
    </specification>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>#10544</title></info>
  <specifications>${body}
  </specifications>
</ids>`;
}

async function selected(text: string, xml: string): Promise<Array<[string, string[]]>> {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, {
    disableWorkerScan: true,
  });
  const report = await validateIDS(parseIDS(xml), createDataAccessor(store), {
    modelId: 'entity-pattern-case',
    schemaVersion: String(store.schemaVersion),
    entityCount: 0,
  });
  return report.specificationResults.map((r) => [
    r.specification.name,
    r.entityResults.map((e) => e.entityName ?? String(e.expressId)).sort(),
  ]);
}

const ELEMENTS = ['C-1', 'F-1', 'S-1', 'W-1'];

/** [name, facets, what IfcTester selects] */
const ROWS: Array<[string, string, string[]]> = [
  ['pattern IFCWALL', entity(pattern('IFCWALL')), ['W-1']],
  ['pattern IfcWall', entity(pattern('IfcWall')), []],
  ['pattern IFCDISTRIBUTION.*ELEMENT', entity(pattern('IFCDISTRIBUTION.*ELEMENT')), ['C-1']],
  ['pattern IfcDistribution.*Element', entity(pattern('IfcDistribution.*Element')), []],
  ['pattern .*Wall', entity(pattern('.*Wall')), []],
  ['pattern IFC[a-z]+', entity(pattern('IFC[a-z]+')), []],
  ['enumeration {IFCWALL, IFCSLAB}', entity(list('IFCWALL', 'IFCSLAB')), ['S-1', 'W-1']],
  ['enumeration {IfcWall, IfcSlab}', entity(list('IfcWall', 'IfcSlab')), []],
  ['enumeration {IFCWALL, IfcSlab}', entity(list('IFCWALL', 'IfcSlab')), ['W-1']],
  ['simple IFCWALL', entity(simple('IFCWALL')), ['W-1']],
  ['partOf pattern IFCBUILDINGSTOREY', partOf(pattern('IFCBUILDINGSTOREY')), ELEMENTS],
  ['partOf pattern IfcBuildingStorey', partOf(pattern('IfcBuildingStorey')), []],
  ['partOf enumeration {IfcBuildingStorey}', partOf(list('IfcBuildingStorey')), []],
  ['partOf simple IFCBUILDINGSTOREY', partOf(simple('IFCBUILDINGSTOREY')), ELEMENTS],
];

describe('#10544: an entity name pattern or enumeration meets the upper-case class', () => {
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3_ADD2']) {
    it(`${schema}: patterns and enumerations select what IfcTester selects`, async () => {
      const xml = ids(schema, ROWS.map(([name, facets]) => [name, facets]));
      expect(await selected(step(schema), xml)).toEqual(ROWS.map(([name, , expected]) => [name, expected]));
    });
  }

  it('IFC2X3 mapping table: a pattern naming IFCAIRTERMINAL selects the typed flow terminal, IfcAirTerminal does not', async () => {
    // IfcTester 0.8.3 does not apply buildingSMART's IFC2X3 occurrence/type
    // mapping table at all (it fails buildingSMART's own pass cases for it),
    // so it selects nothing for either. IFC Lite applies the table, and the
    // alias is an upper-case class name like any other.
    const xml = ids('IFC2X3', [
      ['pattern IFCAIRTERMINAL', entity(pattern('IFCAIRTERMINAL'))],
      ['pattern IfcAirTerminal', entity(pattern('IfcAirTerminal'))],
      ['enumeration {IfcAirTerminal}', entity(list('IfcAirTerminal'))],
    ]);
    expect(await selected(step('IFC2X3'), xml)).toEqual([
      ['pattern IFCAIRTERMINAL', ['F-1']],
      ['pattern IfcAirTerminal', []],
      ['enumeration {IfcAirTerminal}', []],
    ]);
  });

  it('the committed sample building-architecture.ifc: IFCWALL as a pattern selects its walls, IfcWall none', async () => {
    const sample = join(dirname(fileURLToPath(import.meta.url)), '../../../../apps/viewer/public/samples/building-architecture.ifc');
    const xml = ids('IFC4', [
      ['simple IFCWALL', entity(simple('IFCWALL'))],
      ['pattern IFCWALL', entity(pattern('IFCWALL'))],
      ['enumeration {IFCWALL}', entity(list('IFCWALL'))],
      ['pattern IfcWall', entity(pattern('IfcWall'))],
      ['enumeration {IfcWall}', entity(list('IfcWall'))],
    ]);
    const [simpleWalls, ...rest] = await selected(readFileSync(sample, 'utf8'), xml);
    expect(simpleWalls[1].length).toBeGreaterThan(0);
    expect(rest).toEqual([
      ['pattern IFCWALL', simpleWalls[1]],
      ['enumeration {IFCWALL}', simpleWalls[1]],
      ['pattern IfcWall', []],
      ['enumeration {IfcWall}', []],
    ]);
  });
});

describe('#10544 controls: simple values stay as they were', () => {
  it('a simple IfcWall is still rejected by the entity facet, and a simple partOf IfcBuildingStorey still matches', async () => {
    // IfcTester 0.8.3 selects W-1 for the first and nothing for the second;
    // IFC Lite follows buildingSMART's
    // entity/invalid-entities_must_be_specified_as_uppercase_strings for the
    // entity facet, and keeps the partOf simple value as it was.
    const xml = ids('IFC4', [
      ['simple IfcWall', entity(simple('IfcWall'))],
      ['partOf simple IfcBuildingStorey', partOf(simple('IfcBuildingStorey'))],
    ]);
    expect(await selected(step('IFC4'), xml)).toEqual([
      ['simple IfcWall', []],
      ['partOf simple IfcBuildingStorey', ELEMENTS],
    ]);
  });
});

describe('#10544 controls: a getEntityType answer that is not a string answers as before', () => {
  // checkEntityFacet is exported, and a JavaScript accessor is not held to
  // `string | undefined`. Before #10544 the class went to matchConstraint as
  // it was, which reads it as text: 42 met no name, and an object whose
  // toString gives 'IfcWall' met IFCWALL. Neither may throw.
  const names: IDSConstraint[] = [
    { type: 'simpleValue', value: 'IFCWALL' },
    { type: 'pattern', pattern: 'IFCWALL' },
    { type: 'enumeration', values: ['IFCWALL'] },
  ];
  const answering = (entityType: unknown): IFCDataAccessor => ({
    ...createMockAccessor([]),
    getSchemaVersion: () => 'IFC4',
    getEntityType: () => entityType as string,
  });
  const cases: Array<[string, unknown, boolean]> = [
    ['42', 42, false],
    ["an object whose toString gives 'IfcWall'", { toString: () => 'IfcWall' }, true],
  ];
  for (const [label, entityType, passed] of cases) {
    it(`${label}: a simple value, a pattern and an enumeration IFCWALL give passed ${passed}`, () => {
      const accessor = answering(entityType);
      for (const name of names) {
        const facet: IDSEntityFacet = { type: 'entity', name };
        expect(checkEntityFacet(facet, 1, accessor).passed).toBe(passed);
        expect(entityFacetPasses(facet, 1, accessor)).toBe(passed);
      }
    });
  }
});
