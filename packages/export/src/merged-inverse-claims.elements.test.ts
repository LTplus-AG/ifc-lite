/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A merge never states a single-valued inverse twice (#5923): containment,
 * typing, voids and fills of GlobalId-unified elements. The row-by-row check of
 * every rule is in `merged-inverse-claims.test.ts`.
 *
 * The merge unifies entities by GlobalId but writes every model's `IfcRel*`
 * lines. Each test below merges a model with a second one that repeats some
 * of its entities by GlobalId and states the same relationship about them,
 * then checks the inverse named in the test holds one relationship. The
 * IfcOpenShell check of the same shape is in
 * `ifcopenshell-schema-conformance.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MergedExporter, type MergeExportOptions, type MergeModelInput } from './merged-exporter.js';

const guid = (label: string): string => (label + '0'.repeat(22)).slice(0, 22);
type Schema = 'IFC2X3' | 'IFC4';

async function model(id: string, lines: string[], schema: Schema = 'IFC4'): Promise<MergeModelInput> {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('m.ifc','2026-01-01T00:00:00',(''),(''),'t','t','');", `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
  return { id, name: id, dataStore };
}

async function merge(models: MergeModelInput[], options: Partial<MergeExportOptions> = {}): Promise<string> {
  return new TextDecoder().decode(new MergedExporter(models).export({ schema: 'IFC4', ...options }).content);
}

/** Final express id of the entity whose GlobalId is `globalId`. */
function idOf(content: string, globalId: string): number {
  const match = new RegExp(`^#(\\d+)=\\w+\\('${globalId}'`, 'm').exec(content);
  expect(match, `${globalId} is in the output`).not.toBeNull();
  return Number(match![1]);
}

/** Every `relType` line as its attribute `listAttr` refs and its attribute `singleAttr` ref. */
function rels(content: string, relType: string, listAttr: number, singleAttr: number): Array<{ list: number[]; single: number }> {
  const out: Array<{ list: number[]; single: number }> = [];
  for (const [line] of content.matchAll(new RegExp(`^#\\d+=${relType}\\(.*$`, 'gm'))) {
    // GlobalId, OwnerHistory, Name, Description never hold a list here.
    const attrs = line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')).match(/\([^)]*\)|'[^']*'|[^,]+/g)!;
    out.push({
      list: [...attrs[listAttr].matchAll(/#(\d+)/g)].map(m => Number(m[1])),
      single: Number(attrs[singleAttr].slice(1)),
    });
  }
  return out;
}

const PROJECT = (tag: string) => `#1=IFCPROJECT('${guid(`p${tag}`)}',$,'${tag}',$,$,$,$,$,$);`;
const STOREY = (tag: string, name = 'Level 1', elevation = '0.') =>
  `#2=IFCBUILDINGSTOREY('${guid(`st${tag}`)}',$,'${name}',$,$,$,$,$,.ELEMENT.,${elevation});`;
/** IFC4 IfcWall adds PredefinedType to IFC2X3's eight attributes. */
const WALL = (n: number, label: string, schema: Schema = 'IFC4') =>
  `#${n}=IFCWALL('${guid(label)}',$,'${label}',$,$,$,$,$${schema === 'IFC4' ? ',$' : ''});`;

describe('one IfcRelContainedInSpatialStructure per element (#5923)', () => {
  const a = (schema: Schema = 'IFC4') =>
    [PROJECT('a'), STOREY('a'), WALL(3, 'w1', schema), `#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rca')}',$,$,$,(#3),#2);`];

  for (const schema of ['IFC2X3', 'IFC4'] as const) {
    it(`${schema}: a GlobalId-unified wall in a unified storey keeps one containment, a new one is still contained`, async () => {
      const b = [PROJECT('b'), STOREY('b'), WALL(3, 'w1', schema), WALL(4, 'w2', schema),
        `#5=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rcb')}',$,$,$,(#3,#4),#2);`];
      const content = await merge([await model('a', a(schema), schema), await model('b', b, schema)], { schema });
      const contained = rels(content, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', 4, 5);
      const storey = idOf(content, guid('sta'));
      expect(contained.filter(r => r.list.includes(idOf(content, guid('w1'))))).toEqual([{ list: [idOf(content, guid('w1'))], single: storey }]);
      expect(contained.filter(r => r.list.includes(idOf(content, guid('w2'))))).toEqual([{ list: [idOf(content, guid('w2'))], single: storey }]);
    });
  }

  it('a GlobalId-unified wall a later model places in a storey that does not unify stays in its first storey', async () => {
    const b = [PROJECT('b'), STOREY('b', 'Level 2', '3.'), WALL(3, 'w1'),
      `#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rcb')}',$,$,$,(#3),#2);`];
    const content = await merge([await model('a', a()), await model('b', b)]);
    expect(content).toContain(guid('stb'));
    expect(content).not.toContain(guid('rcb'));
    const contained = rels(content, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', 4, 5);
    expect(contained).toEqual([{ list: [idOf(content, guid('w1'))], single: idOf(content, guid('sta')) }]);
  });
});

describe('the other single-valued inverses of a unified element (#5923)', () => {
  it('IFC4: one IfcRelDefinesByType per object and per type, one void and one fill', async () => {
    const shared = [
      WALL(3, 'w1'),
      `#4=IFCWALLTYPE('${guid('wt')}',$,'T',$,$,$,$,$,$,.STANDARD.);`,
      `#6=IFCOPENINGELEMENT('${guid('op')}',$,'O',$,$,$,$,$,.OPENING.);`,
      `#7=IFCDOOR('${guid('dr')}',$,'D',$,$,$,$,$,$,$,$,$,$);`,
    ];
    const relsOf = (tag: string, typed: string) => [
      `#20=IFCRELDEFINESBYTYPE('${guid(`rt${tag}`)}',$,$,$,(${typed}),#4);`,
      `#22=IFCRELVOIDSELEMENT('${guid(`rv${tag}`)}',$,$,$,#3,#6);`,
      `#23=IFCRELFILLSELEMENT('${guid(`rf${tag}`)}',$,$,$,#6,#7);`,
    ];
    const a = [PROJECT('a'), ...shared, ...relsOf('a', '#3')];
    const b = [PROJECT('b'), ...shared, WALL(8, 'w2'), ...relsOf('b', '#3,#8')];
    const content = await merge([await model('a', a), await model('b', b)]);
    const [w1, w2, wt] = [idOf(content, guid('w1')), idOf(content, guid('w2')), idOf(content, guid('wt'))];
    // IsTypedBy and Types: B's new wall joins A's rel, B's rel is not written.
    expect(rels(content, 'IFCRELDEFINESBYTYPE', 4, 5)).toEqual([{ list: [w1, w2], single: wt }]);
    expect(rels(content, 'IFCRELVOIDSELEMENT', 5, 4)).toHaveLength(1);
    expect(rels(content, 'IFCRELFILLSELEMENT', 5, 4)).toHaveLength(1);
    for (const tag of ['rtb', 'rvb', 'rfb']) expect(content).not.toContain(guid(tag));
  });

  it('keeps a later model\'s relationships when nothing is unified (control)', async () => {
    const a = [PROJECT('a'), STOREY('a'), WALL(3, 'w1'), `#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rca')}',$,$,$,(#3),#2);`];
    const b = [PROJECT('b'), STOREY('b'), WALL(3, 'w9'), `#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rcb')}',$,$,$,(#3),#2);`];
    const content = await merge([await model('a', a), await model('b', b)]);
    expect(rels(content, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', 4, 5)).toHaveLength(2);
  });
});
