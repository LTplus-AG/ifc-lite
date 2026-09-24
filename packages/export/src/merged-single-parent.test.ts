/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A merge never gives an object a second IfcRelAggregates parent (#5471).
 *
 * `IfcObjectDefinition.Decomposes` is `SET [0:1]`, and
 * `IfcSpatialStructureElement.WR41` requires exactly one for a building or
 * storey. The reported case: model A aggregates its Building under a Site,
 * model B aggregates its Building straight under its Project. The two
 * Buildings unify, and B's `(Project, (Building))` remaps onto A's, so A's
 * Building ended up under both its Site and the Project. The IfcOpenShell
 * version of this check, on the two real fixtures from the report, is in
 * `ifcopenshell-schema-conformance.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MergedExporter, type MergeExportOptions, type MergeModelInput } from './merged-exporter.js';

const guid = (label: string): string => (label + '0'.repeat(22)).slice(0, 22);

async function model(id: string, lines: string[]): Promise<MergeModelInput> {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('m.ifc','2026-01-01T00:00:00',(''),(''),'t','t','');", "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const bytes = new TextEncoder().encode(text);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
  return { id, name: id, dataStore };
}

async function merge(models: MergeModelInput[], options: Partial<MergeExportOptions> = {}): Promise<string> {
  return new TextDecoder().decode(new MergedExporter(models).export({ schema: 'IFC4', ...options }).content);
}

/** Every IFCRELAGGREGATES line as `{ relating, related[] }`. */
function aggregates(content: string): Array<{ relating: number; related: number[] }> {
  return [...content.matchAll(/^#\d+=IFCRELAGGREGATES\('[^']*',[^,]*,[^,]*,[^,]*,#(\d+),\(([^)]*)\)\);$/gm)].map(m => ({
    relating: Number(m[1]),
    related: [...m[2].matchAll(/#(\d+)/g)].map(r => Number(r[1])),
  }));
}

/** The aggregation parents of the entity whose line starts `#id=TYPE('guid'`. */
function parentsOf(content: string, type: string, globalId: string): number[] {
  const line = content.split('\n').find(l => l.includes(`=${type}('${globalId}'`));
  expect(line, `${type} ${globalId} is in the output`).toBeDefined();
  const id = Number(line!.slice(1, line!.indexOf('=')));
  return aggregates(content).filter(r => r.related.includes(id)).map(r => r.relating);
}

/** No object anywhere is a RelatedObjects member of two IfcRelAggregates. */
function expectSingleParents(content: string): void {
  const seen = new Map<number, number>();
  for (const { related } of aggregates(content)) {
    for (const id of related) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
}

const SITE_BUILDING = [
  `#1=IFCPROJECT('${guid('pa')}',$,'A',$,$,$,$,$,$);`,
  `#2=IFCSITE('${guid('sa')}',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
  `#3=IFCBUILDING('${guid('ba')}',$,'House',$,$,$,$,$,.ELEMENT.,$,$,$);`,
  `#4=IFCRELAGGREGATES('${guid('ra1')}',$,$,$,#1,(#2));`,
  `#5=IFCRELAGGREGATES('${guid('ra2')}',$,$,$,#2,(#3));`,
];
/** Model B: its Building sits directly under its Project, with no Site. */
const PROJECT_BUILDING = (tag: string) => [
  `#1=IFCPROJECT('${guid(`p${tag}`)}',$,'B',$,$,$,$,$,$);`,
  `#2=IFCBUILDING('${guid(`b${tag}`)}',$,'Test Building',$,$,$,$,$,.ELEMENT.,$,$,$);`,
  `#3=IFCRELAGGREGATES('${guid(`r${tag}`)}',$,$,$,#1,(#2));`,
];

describe('MergedExporter keeps one IfcRelAggregates parent per object (#5471)', () => {
  it('does not add a Project parent to a Building the primary aggregates under a Site', async () => {
    const content = await merge([await model('a', SITE_BUILDING), await model('b', PROJECT_BUILDING('b'))]);
    // B's Building unified into A's, so it is gone from the output.
    expect(content).not.toContain(guid('bb'));
    // A's Building keeps exactly its Site parent (#2).
    expect(parentsOf(content, 'IFCBUILDING', guid('ba'))).toEqual([2]);
    // B's rel had nothing else to say, so it is not written at all.
    expect(content).not.toContain(guid('rb'));
    expectSingleParents(content);
  });

  it('keeps the only parent a unified object gets, and a third model does not add another', async () => {
    // The primary's Building has no parent at all, so B's rel is the only
    // statement of its parentage and is kept (#3550); C's then adds nothing.
    const orphan = [
      `#1=IFCPROJECT('${guid('pa')}',$,'A',$,$,$,$,$,$);`,
      `#2=IFCBUILDING('${guid('ba')}',$,'House',$,$,$,$,$,.ELEMENT.,$,$,$);`,
    ];
    const content = await merge([
      await model('a', orphan), await model('b', PROJECT_BUILDING('b')), await model('c', PROJECT_BUILDING('c')),
    ]);
    expect(parentsOf(content, 'IFCBUILDING', guid('ba'))).toEqual([1]);
    expect(content).toContain(guid('rb'));
    expect(content).not.toContain(guid('rc'));
    expectSingleParents(content);
  });

  it('strips a GlobalId-unified member that already has a parent, keeping the new one', async () => {
    // B repeats A's roof and one of its slabs by GlobalId, plus a new slab.
    // Only the new slab still needs B's aggregation; the repeated one already
    // has A's roof as its parent.
    const roofA = [
      ...SITE_BUILDING,
      `#6=IFCROOF('${guid('roof')}',$,'Roof',$,$,$,$,$,.GABLE_ROOF.);`,
      `#7=IFCSLAB('${guid('s1')}',$,'S1',$,$,$,$,$,.ROOF.);`,
      `#8=IFCRELAGGREGATES('${guid('ra3')}',$,$,$,#6,(#7));`,
    ];
    const roofB = [
      `#1=IFCPROJECT('${guid('pb')}',$,'B',$,$,$,$,$,$);`,
      `#2=IFCROOF('${guid('roof')}',$,'Roof',$,$,$,$,$,.GABLE_ROOF.);`,
      `#3=IFCSLAB('${guid('s1')}',$,'S1',$,$,$,$,$,.ROOF.);`,
      `#4=IFCSLAB('${guid('s2')}',$,'S2',$,$,$,$,$,.ROOF.);`,
      `#5=IFCRELAGGREGATES('${guid('rb3')}',$,$,$,#2,(#3,#4));`,
    ];
    const content = await merge([await model('a', roofA), await model('b', roofB)]);
    expect(parentsOf(content, 'IFCSLAB', guid('s1'))).toEqual([6]);
    expect(parentsOf(content, 'IFCSLAB', guid('s2'))).toEqual([6]);
    expectSingleParents(content);
  });

  it('counts only parents that are written: a hidden primary parent leaves the later one in place', async () => {
    // visibleOnly with A's roof hidden: A's roof -> slab rel is withheld, so
    // B's rel is the slab's only written parent and must not be dropped as
    // redundant, or the slab is left with none.
    const roofA = [
      ...SITE_BUILDING,
      `#6=IFCROOF('${guid('roof')}',$,'Roof A',$,$,$,$,$,.GABLE_ROOF.);`,
      `#7=IFCSLAB('${guid('s1')}',$,'S1',$,$,$,$,$,.ROOF.);`,
      `#8=IFCRELAGGREGATES('${guid('ra3')}',$,$,$,#6,(#7));`,
    ];
    const roofB = [
      `#1=IFCPROJECT('${guid('pb')}',$,'B',$,$,$,$,$,$);`,
      `#2=IFCROOF('${guid('roofb')}',$,'Roof B',$,$,$,$,$,.GABLE_ROOF.);`,
      `#3=IFCSLAB('${guid('s1')}',$,'S1',$,$,$,$,$,.ROOF.);`,
      `#4=IFCRELAGGREGATES('${guid('rb3')}',$,$,$,#2,(#3));`,
    ];
    const content = await merge([await model('a', roofA), await model('b', roofB)], {
      visibleOnly: true,
      hiddenEntityIdsByModel: new Map([['a', new Set([6])]]),
    });
    expect(content).not.toContain(guid('roof'));
    expect(content).toContain(guid('rb3'));
    expect(parentsOf(content, 'IFCSLAB', guid('s1'))).toHaveLength(1);
    expectSingleParents(content);
  });

  it('with the primary parent visible, the same merge still drops the later duplicate', async () => {
    // Control for the case above: without the hidden roof the slab already
    // has A's roof as its written parent, so B's rel adds nothing.
    const roofA = [
      ...SITE_BUILDING,
      `#6=IFCROOF('${guid('roof')}',$,'Roof A',$,$,$,$,$,.GABLE_ROOF.);`,
      `#7=IFCSLAB('${guid('s1')}',$,'S1',$,$,$,$,$,.ROOF.);`,
      `#8=IFCRELAGGREGATES('${guid('ra3')}',$,$,$,#6,(#7));`,
    ];
    const roofB = [
      `#1=IFCPROJECT('${guid('pb')}',$,'B',$,$,$,$,$,$);`,
      `#2=IFCROOF('${guid('roofb')}',$,'Roof B',$,$,$,$,$,.GABLE_ROOF.);`,
      `#3=IFCSLAB('${guid('s1')}',$,'S1',$,$,$,$,$,.ROOF.);`,
      `#4=IFCRELAGGREGATES('${guid('rb3')}',$,$,$,#2,(#3));`,
    ];
    const content = await merge([await model('a', roofA), await model('b', roofB)], { visibleOnly: true });
    expect(parentsOf(content, 'IFCSLAB', guid('s1'))).toEqual([6]);
    expect(content).not.toContain(guid('rb3'));
    expectSingleParents(content);
  });

  it('keeps one parent with dropEmptyContainers on', async () => {
    // The Building has content, so the empty-container pass keeps it.
    const withContent = [
      ...SITE_BUILDING,
      `#6=IFCBUILDINGELEMENTPROXY('${guid('px')}',$,'P',$,$,$,$,$,$);`,
      `#7=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rc')}',$,$,$,(#6),#3);`,
    ];
    const content = await merge(
      [await model('a', withContent), await model('b', PROJECT_BUILDING('b'))],
      { dropEmptyContainers: true },
    );
    expect(parentsOf(content, 'IFCBUILDING', guid('ba'))).toEqual([2]);
    expectSingleParents(content);
  });
});
