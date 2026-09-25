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

async function model(id: string, lines: string[], schema = 'IFC4'): Promise<MergeModelInput> {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('m.ifc','2026-01-01T00:00:00',(''),(''),'t','t','');", `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const bytes = new TextEncoder().encode(text);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
  return { id, name: id, dataStore };
}

async function merge(models: MergeModelInput[], options: Partial<MergeExportOptions> = {}): Promise<string> {
  return new TextDecoder().decode(new MergedExporter(models).export({ schema: 'IFC4', ...options }).content);
}

/** Every `relType` line (IFCRELAGGREGATES by default) as `{ relating, related[] }`. */
function aggregates(content: string, relType = 'IFCRELAGGREGATES'): Array<{ relating: number; related: number[] }> {
  const re = new RegExp(`^#\\d+=${relType}\\('[^']*',[^,]*,[^,]*,[^,]*,#(\\d+),\\(([^)]*)\\)\\);$`, 'gm');
  return [...content.matchAll(re)].map(m => ({
    relating: Number(m[1]),
    related: [...m[2].matchAll(/#(\d+)/g)].map(r => Number(r[1])),
  }));
}

/** The parents, through any of `relTypes`, of the entity whose line starts `#id=TYPE('guid'`. */
function parentsOf(content: string, type: string, globalId: string, relTypes = ['IFCRELAGGREGATES']): number[] {
  const line = content.split('\n').find(l => l.includes(`=${type}('${globalId}'`));
  expect(line, `${type} ${globalId} is in the output`).toBeDefined();
  const id = Number(line!.slice(1, line!.indexOf('=')));
  return relTypes.flatMap(relType => aggregates(content, relType).filter(r => r.related.includes(id)).map(r => r.relating));
}

/** No object anywhere is a RelatedObjects member of two of `relTypes` (one SET [0:1] inverse). */
function expectSingleParents(content: string, relTypes = ['IFCRELAGGREGATES']): void {
  const seen = new Map<number, number>();
  for (const { related } of relTypes.flatMap(relType => aggregates(content, relType))) {
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

/**
 * `dropEmptyContainers` has to see the rels the one-parent pass skips (#5725).
 * The drop plan is made before the per-model claim pass runs. It counted B's
 * `Site_B -> Building` edge, but that edge is never written because A's
 * Building already has a parent. Site_B then held nothing and was still
 * written.
 */
describe('MergedExporter dropEmptyContainers after the one-parent pass (#5725)', () => {
  const siteA = [
    `#1=IFCPROJECT('${guid('pa')}',$,'A',$,$,$,$,$,$);`,
    `#2=IFCSITE('${guid('sa')}',$,'Site A',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
    `#3=IFCBUILDING('${guid('ba')}',$,'House',$,$,$,$,$,.ELEMENT.,$,$,$);`,
    `#4=IFCRELAGGREGATES('${guid('ra1')}',$,$,$,#1,(#2));`,
    `#5=IFCRELAGGREGATES('${guid('ra2')}',$,$,$,#2,(#3));`,
    `#6=IFCBUILDINGELEMENTPROXY('${guid('px')}',$,'P',$,$,$,$,$,$);`,
    `#7=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rc')}',$,$,$,(#6),#3);`,
  ];
  /** B: its own Site (by-name, so it does not unify), over a Building that unifies with A's. */
  const siteB = (extra: string[] = []) => [
    `#1=IFCPROJECT('${guid('pb')}',$,'B',$,$,$,$,$,$);`,
    `#2=IFCSITE('${guid('sb')}',$,'Site B',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
    `#3=IFCBUILDING('${guid('bb')}',$,'House',$,$,$,$,$,.ELEMENT.,$,$,$);`,
    `#4=IFCRELAGGREGATES('${guid('rb1')}',$,$,$,#1,(#2));`,
    `#5=IFCRELAGGREGATES('${guid('rb2')}',$,$,$,#2,(#3${extra.length > 0 ? ',#6' : ''}));`,
    ...extra,
  ];
  const options: Partial<MergeExportOptions> = { mergeSites: 'by-name', dropEmptyContainers: true };

  it('drops a later Site left empty because its only child already has a parent', async () => {
    const content = await merge([await model('a', siteA), await model('b', siteB())], options);
    expect(content).toContain(guid('sa'));
    expect(content).not.toContain(guid('sb'));
    // Nothing still names it: its Project aggregation went with it.
    expect(content).not.toContain(guid('rb1'));
    expect(parentsOf(content, 'IFCBUILDING', guid('ba'))).toEqual([2]);
    expectSingleParents(content);
  });

  it('keeps that Site when the same rel still carries a child of its own', async () => {
    // B's Site also aggregates a Building A does not have, so the rel is
    // narrowed (the unified Building is stripped) rather than skipped, and
    // Site B is not empty.
    const own = [
      `#6=IFCBUILDING('${guid('bo')}',$,'Annex',$,$,$,$,$,.ELEMENT.,$,$,$);`,
      `#7=IFCBUILDINGELEMENTPROXY('${guid('po')}',$,'Q',$,$,$,$,$,$);`,
      `#8=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rco')}',$,$,$,(#7),#6);`,
    ];
    const content = await merge([await model('a', siteA), await model('b', siteB(own))], {
      ...options, mergeBuildings: 'by-name',
    });
    expect(content).toContain(guid('sb'));
    expect(parentsOf(content, 'IFCBUILDING', guid('ba'))).toEqual([2]);
    const siteBId = Number(content.split('\n').find(l => l.includes(`('${guid('sb')}'`))!.match(/^#(\d+)=/)![1]);
    expect(parentsOf(content, 'IFCBUILDING', guid('bo'))).toEqual([siteBId]);
    expectSingleParents(content);
  });

  /** Every written Building and Storey still has an aggregation parent (WR41). */
  const expectNoOrphanedContainers = (content: string) => {
    const members = new Set(aggregates(content).flatMap(r => r.related));
    const orphans = [...content.matchAll(/^#(\d+)=IFC(BUILDING|BUILDINGSTOREY)\(/gm)].map(m => Number(m[1])).filter(id => !members.has(id));
    expect(orphans).toEqual([]);
  };
  const siteOnly = [
    `#1=IFCPROJECT('${guid('pa')}',$,'A',$,$,$,$,$,$);`,
    `#2=IFCSITE('${guid('sa')}',$,'Site A',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
    `#3=IFCRELAGGREGATES('${guid('ra1')}',$,$,$,#1,(#2));`,
    `#4=IFCBUILDINGELEMENTPROXY('${guid('px')}',$,'P',$,$,$,$,$,$);`,
    `#5=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rc')}',$,$,$,(#4),#2);`,
  ];
  /** Building `b` over a Storey with GlobalId `storey` that holds a proxy; ids from `base`. */
  const buildingWithStorey = (b: string, storey: string, base: number) => [
    `#${base}=IFCBUILDING('${guid(b)}',$,'${b}',$,$,$,$,$,.ELEMENT.,$,$,$);`,
    `#${base + 1}=IFCBUILDINGSTOREY('${guid(storey)}',$,'S ${b}',$,$,$,$,$,.ELEMENT.,$);`,
    `#${base + 2}=IFCRELAGGREGATES('${guid(`r${b}`)}',$,$,$,#${base},(#${base + 1}));`,
    `#${base + 3}=IFCBUILDINGELEMENTPROXY('${guid(`x${b}`)}',$,'P',$,$,$,$,$,$);`,
    `#${base + 4}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(`c${b}`)}',$,$,$,(#${base + 3}),#${base + 1});`,
  ];
  const byName = { dropEmptyContainers: true, mergeBuildings: 'by-name', mergeStoreys: 'by-name' } as const;

  it('never drops the parent of a full storey that shares a GlobalId within its own model', async () => {
    // B's two storeys repeat one GlobalId (an authoring-tool defect). The emit
    // pass unifies GlobalIds only against EARLIER models, so both storeys are
    // written; the planner must not treat the second as already parented and
    // drop its Building.
    const b = [
      `#1=IFCPROJECT('${guid('pb')}',$,'B',$,$,$,$,$,$);`,
      ...buildingWithStorey('b1', 'dup', 10), ...buildingWithStorey('b2', 'dup', 20),
      `#2=IFCRELAGGREGATES('${guid('rb0')}',$,$,$,#1,(#10,#20));`,
    ];
    const content = await merge([await model('a', siteOnly), await model('b', b)], byName);
    expect(content).toContain(guid('b2'));
    expectNoOrphanedContainers(content);
    expectSingleParents(content);
  });

  it('never drops the parent of a full storey the emit pass does not unify (assume-shared, 3 models)', async () => {
    // B and C share a storey GlobalId, but under assume-shared C only unifies
    // against an emitter in the primary unit, and B declares another one.
    const later = (tag: string) => async () => {
      const lines = [
        `#1=IFCPROJECT('${guid(`p${tag}`)}',$,'${tag}',$,$,$,$,$,$);`,
        ...buildingWithStorey(`b${tag}`, 'st', 10),
        `#2=IFCRELAGGREGATES('${guid(`r0${tag}`)}',$,$,$,#1,(#10));`,
      ];
      return { ...(await model(tag, lines)), lengthUnitScale: 0.001 };
    };
    const content = await merge(
      [{ ...(await model('a', siteOnly)), lengthUnitScale: 1 }, await later('b')(), await later('c')()],
      { ...byName, unitReconciliation: 'assume-shared' },
    );
    expect(content).toContain(guid('bc'));
    expectNoOrphanedContainers(content);
    expectSingleParents(content);
  });

  it('IFC2X3: a nest under a dropped container does not make the planner withhold a written aggregation', async () => {
    // In IFC2X3 IfcRelNests and IfcRelAggregates share `Decomposes`. A's
    // House is NESTED under Site A, which holds nothing through a structure
    // rel, so Site A is dropped and its nest goes with it. B's `Site B ->
    // House` aggregation is then House's only parent. A planner that also
    // claimed parents through the nest withheld B's edge, dropped Site B as
    // empty, and left House with no parent at all (WR41).
    const nestedA = [
      `#1=IFCPROJECT('${guid('pa')}',$,'A',$,$,$,$,$,$);`,
      `#2=IFCSITE('${guid('sa')}',$,'Site A',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
      `#3=IFCBUILDING('${guid('ba')}',$,'House',$,$,$,$,$,.ELEMENT.,$,$,$);`,
      `#4=IFCRELAGGREGATES('${guid('ra1')}',$,$,$,#1,(#2));`,
      `#5=IFCRELNESTS('${guid('rn')}',$,$,$,#2,(#3));`,
      `#6=IFCBUILDINGELEMENTPROXY('${guid('px')}',$,'P',$,$,$,$,$,$);`,
      `#7=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rc')}',$,$,$,(#6),#3);`,
    ];
    const content = await merge([await model('a', nestedA, 'IFC2X3'), await model('b', siteB(), 'IFC2X3')], {
      ...options, mergeBuildings: 'by-name', schema: 'IFC2X3',
    });
    expect(content).not.toContain(guid('sa'));
    expect(content).toContain(guid('sb'));
    expect(content).toContain(guid('rb2'));
    expectNoOrphanedContainers(content);
    expectSingleParents(content, ['IFCRELAGGREGATES', 'IFCRELNESTS']);
  });

  it('drops it too when the narrowed rel keeps only an empty sibling', async () => {
    // Same rel, but the Annex holds nothing. With the unified Building
    // stripped, Site B's only written child is the empty Annex, so both go.
    const emptyAnnex = [`#6=IFCBUILDING('${guid('bo')}',$,'Annex',$,$,$,$,$,.ELEMENT.,$,$,$);`];
    const content = await merge([await model('a', siteA), await model('b', siteB(emptyAnnex))], {
      ...options, mergeBuildings: 'by-name',
    });
    expect(content).not.toContain(guid('bo'));
    expect(content).not.toContain(guid('sb'));
    expect(content).not.toContain(guid('rb2'));
    expect(parentsOf(content, 'IFCBUILDING', guid('ba'))).toEqual([2]);
    expectSingleParents(content);
  });
});

/**
 * `dropEmptyContainers` sees children unified by GlobalId alone (#5937). The
 * planner resolved ids only through spatial unification, so a later Site whose
 * only child repeats the primary's Building by GlobalId (under another name, so
 * spatial matching misses it) still counted that edge. The emit pass withholds
 * it, since the Building already has a parent, and the Site was written empty.
 */
describe('MergedExporter dropEmptyContainers after GlobalId-only unification (#5937)', () => {
  const primary = [
    `#1=IFCPROJECT('${guid('pa')}',$,'A',$,$,$,$,$,$);`,
    `#2=IFCSITE('${guid('sa')}',$,'Site A',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
    `#3=IFCBUILDING('${guid('ba')}',$,'House',$,$,$,$,$,.ELEMENT.,$,$,$);`,
    `#4=IFCRELAGGREGATES('${guid('ra1')}',$,$,$,#1,(#2));`,
    `#5=IFCRELAGGREGATES('${guid('ra2')}',$,$,$,#2,(#3));`,
    `#6=IFCBUILDINGELEMENTPROXY('${guid('px')}',$,'P',$,$,$,$,$,$);`,
    `#7=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rc')}',$,$,$,(#6),#3);`,
  ];
  /** B: its own Site over A's Building by GlobalId, renamed so by-name matching does not unify it. */
  const later = [
    `#1=IFCPROJECT('${guid('pb')}',$,'B',$,$,$,$,$,$);`,
    `#2=IFCSITE('${guid('sb')}',$,'Site B',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
    `#3=IFCBUILDING('${guid('ba')}',$,'House (renamed)',$,$,$,$,$,.ELEMENT.,$,$,$);`,
    `#4=IFCRELAGGREGATES('${guid('rb1')}',$,$,$,#1,(#2));`,
    `#5=IFCRELAGGREGATES('${guid('rb2')}',$,$,$,#2,(#3));`,
  ];
  const byName = { dropEmptyContainers: true, mergeSites: 'by-name', mergeBuildings: 'by-name' } as const;
  const expectNoOrphanedContainers = (content: string) => {
    const members = new Set(aggregates(content).flatMap(r => r.related));
    const orphans = [...content.matchAll(/^#(\d+)=IFC(BUILDING|BUILDINGSTOREY)\(/gm)].map(m => Number(m[1])).filter(id => !members.has(id));
    expect(orphans).toEqual([]);
  };

  it('drops a later Site whose only child unifies with the primary\'s by GlobalId', async () => {
    const content = await merge([await model('a', primary), await model('b', later)], byName);
    expect(content).not.toContain(guid('sb'));
    expect(content).not.toContain(guid('rb1'));
    expect(parentsOf(content, 'IFCBUILDING', guid('ba'))).toEqual([2]);
    expectNoOrphanedContainers(content);
    expectSingleParents(content);
  });

  /** Model `tag`: its own Site aggregating `child` (a line at #3). */
  const siteOver = (tag: string, siteName: string, child: string) => [
    `#1=IFCPROJECT('${guid(`p${tag}`)}',$,'${tag}',$,$,$,$,$,$);`,
    `#2=IFCSITE('${guid(`s${tag}`)}',$,'${siteName}',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
    child,
    `#4=IFCRELAGGREGATES('${guid(`r1${tag}`)}',$,$,$,#1,(#2));`,
    `#5=IFCRELAGGREGATES('${guid(`r2${tag}`)}',$,$,$,#2,(#3));`,
  ];

  it('never resolves through a GlobalId that schema conversion re-mints', async () => {
    // IFC4 cannot represent an IfcAlignmentHorizontal, so each is written as
    // an IFCPROXY with a fresh GlobalId, and B's is not unified onto A's: Site
    // B's aggregation of it is written. Resolving it by the source GlobalId
    // would withhold that edge, drop Site B as empty and leave B's proxy
    // without its parent. (A degenerate aggregation, kept minimal: any child
    // the conversion re-mints will do.)
    const alignment = `#3=IFCALIGNMENTHORIZONTAL('${guid('al')}',$,'Axis',$,$,$,$);`;
    const content = await merge(
      [await model('a', siteOver('a', 'Site A', alignment), 'IFC4X3_ADD2'), await model('b', siteOver('b', 'Site B', alignment), 'IFC4X3_ADD2')],
      byName,
    );
    expect(content).toContain(guid('sb'));
    expect(content).toContain(guid('r2b'));
    expectSingleParents(content);
  });

  it('never resolves a non-container through a container\'s GlobalId', async () => {
    // A degenerate reuse: B's proxy carries the GlobalId of A's Building. A's
    // Building holds nothing and is dropped, so it is never written, and B's
    // proxy is written as itself under Site B.
    const content = await merge([
      await model('a', siteOver('a', 'Site A', `#3=IFCBUILDING('${guid('ba')}',$,'Empty',$,$,$,$,$,.ELEMENT.,$,$,$);`)),
      await model('b', siteOver('b', 'Site B', `#3=IFCBUILDINGELEMENTPROXY('${guid('ba')}',$,'Reused',$,$,$,$,$,$);`)),
    ], byName);
    expect(content).toContain(guid('sb'));
    expect(content).toContain(guid('r2b'));
    expectSingleParents(content);
  });

  it('resolves a GlobalId a model writes twice onto the copy the emit pass records: the last', async () => {
    // B repeats one storey GlobalId: the first copy under Building b1, the
    // second with no parent. C's storey carries it too, and the emit pass
    // unifies it onto B's LAST copy, which C's Building then parents.
    // Resolving it onto the first copy (already parented) would withhold that
    // edge, drop C's Building and leave the storey with no parent (WR41).
    const storey = (id: number, name: string) => `#${id}=IFCBUILDINGSTOREY('${guid('dup')}',$,'${name}',$,$,$,$,$,.ELEMENT.,$);`;
    const holds = (id: number, tag: string, container: number) => [
      `#${id}=IFCBUILDINGELEMENTPROXY('${guid(`x${tag}`)}',$,'P',$,$,$,$,$,$);`,
      `#${id + 1}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(`c${tag}`)}',$,$,$,(#${id}),#${container});`,
    ];
    const b = [
      `#1=IFCPROJECT('${guid('pb')}',$,'B',$,$,$,$,$,$);`,
      `#2=IFCBUILDING('${guid('b1')}',$,'b1',$,$,$,$,$,.ELEMENT.,$,$,$);`, storey(3, 'S b1'),
      `#4=IFCRELAGGREGATES('${guid('rb0')}',$,$,$,#1,(#2));`, `#5=IFCRELAGGREGATES('${guid('rb1')}',$,$,$,#2,(#3));`,
      ...holds(6, 'b1', 3), storey(8, 'S b2'), ...holds(9, 'b2', 8),
    ];
    const c = [
      `#1=IFCPROJECT('${guid('pc')}',$,'C',$,$,$,$,$,$);`,
      `#2=IFCBUILDING('${guid('bc')}',$,'bc',$,$,$,$,$,.ELEMENT.,$,$,$);`, storey(3, 'S bc'),
      `#4=IFCRELAGGREGATES('${guid('rc0')}',$,$,$,#1,(#2));`, `#5=IFCRELAGGREGATES('${guid('rc1')}',$,$,$,#2,(#3));`,
    ];
    const siteOnly = [
      `#1=IFCPROJECT('${guid('pa')}',$,'A',$,$,$,$,$,$);`,
      `#2=IFCSITE('${guid('sa')}',$,'Site A',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
      `#3=IFCRELAGGREGATES('${guid('ra1')}',$,$,$,#1,(#2));`,
      ...holds(4, 'a', 2),
    ];
    const content = await merge([await model('a', siteOnly), await model('b', b), await model('c', c)], {
      ...byName, mergeStoreys: 'by-name',
    });
    // B's second copy, which the source leaves unparented, gets C's Building.
    expect(content).toContain(guid('bc'));
    expectNoOrphanedContainers(content);
    expectSingleParents(content);
  });

  it('drops a later storey whose only element unifies with the primary\'s by GlobalId (containment, #5923)', async () => {
    // B's storey does not unify (another name), and its one wall is A's by
    // GlobalId. A already contains that wall, so B's containment is withheld
    // and B's storey holds nothing.
    const a = [
      ...primary,
      `#8=IFCBUILDINGSTOREY('${guid('la')}',$,'Level A',$,$,$,$,$,.ELEMENT.,0.);`,
      `#9=IFCRELAGGREGATES('${guid('ra3')}',$,$,$,#3,(#8));`,
      `#10=IFCWALL('${guid('wall')}',$,'W',$,$,$,$,$,$);`,
      `#11=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rca')}',$,$,$,(#10),#8);`,
    ];
    const b = [
      `#1=IFCPROJECT('${guid('pb')}',$,'B',$,$,$,$,$,$);`,
      `#2=IFCBUILDING('${guid('ba')}',$,'House',$,$,$,$,$,.ELEMENT.,$,$,$);`,
      `#3=IFCBUILDINGSTOREY('${guid('lb')}',$,'Level B',$,$,$,$,$,.ELEMENT.,3.);`,
      `#4=IFCRELAGGREGATES('${guid('rb1')}',$,$,$,#1,(#2));`,
      `#5=IFCRELAGGREGATES('${guid('rb2')}',$,$,$,#2,(#3));`,
      `#6=IFCWALL('${guid('wall')}',$,'W',$,$,$,$,$,$);`,
      `#7=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rcb')}',$,$,$,(#6),#3);`,
    ];
    const content = await merge([await model('a', a), await model('b', b)], { ...byName, mergeStoreys: 'by-name' });
    expect(content).toContain(guid('la'));
    expect(content).not.toContain(guid('lb'));
    expect(content).not.toContain(guid('rcb'));
    expectNoOrphanedContainers(content);
    expectSingleParents(content);
  });

  it('IFC4X3: drops an empty facility part, and a later Site over a Road unified by GlobalId', async () => {
    const road = (tag: string, site: string, siteName: string, part: boolean) => [
      `#1=IFCPROJECT('${guid(`p${tag}`)}',$,'${tag}',$,$,$,$,$,$);`,
      `#2=IFCSITE('${guid(site)}',$,'${siteName}',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
      `#3=IFCROAD('${guid('road')}',$,'Road',$,$,$,$,$,$,$);`,
      `#4=IFCRELAGGREGATES('${guid(`r1${tag}`)}',$,$,$,#1,(#2));`,
      `#5=IFCRELAGGREGATES('${guid(`r2${tag}`)}',$,$,$,#2,(#3));`,
      ...(part ? [
        `#6=IFCROADPART('${guid('carriageway')}',$,'Carriageway',$,$,$,$,$,$,$,$);`,
        `#7=IFCROADPART('${guid('shoulder')}',$,'Shoulder',$,$,$,$,$,$,$,$);`,
        `#8=IFCRELAGGREGATES('${guid('r3')}',$,$,$,#3,(#6,#7));`,
        `#9=IFCPAVEMENT('${guid('pave')}',$,'Pavement',$,$,$,$,$,$);`,
        `#10=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('rc')}',$,$,$,(#9),#6);`,
      ] : []),
    ];
    const content = await merge(
      [await model('a', road('a', 'sa', 'Site A', true), 'IFC4X3_ADD2'), await model('b', road('b', 'sb', 'Site B', false), 'IFC4X3_ADD2')],
      { ...byName, schema: 'IFC4X3' },
    );
    expect(content).toContain(guid('carriageway'));
    expect(content).not.toContain(guid('shoulder'));
    expect(content).not.toContain(guid('sb'));
    expect(parentsOf(content, 'IFCROAD', guid('road'))).toEqual([2]);
    expectSingleParents(content);
  });
});

/**
 * IfcRelNests shares the one-parent rule (#5726). In IFC2X3 it is an
 * IfcRelDecomposes like IfcRelAggregates, so the two fill one
 * `Decomposes : SET [0:1]` together; IFC4 moves it to its own
 * `Nests : SET [0:1]`. Which pairs collide is the OUTPUT schema's call.
 */
describe('MergedExporter keeps one IfcRelNests parent per object, per output schema (#5726)', () => {
  const proxy = (id: number, tag: string, name: string) =>
    `#${id}=IFCBUILDINGELEMENTPROXY('${guid(tag)}',$,'${name}',$,$,$,$,$,$);`;
  /** A aggregates the part under its unit; B nests the same part (by GlobalId) under a housing. */
  const AGGREGATED = [
    `#1=IFCPROJECT('${guid('pa')}',$,'A',$,$,$,$,$,$);`,
    proxy(2, 'unit', 'Unit'), proxy(3, 'part', 'Part'),
    `#4=IFCRELAGGREGATES('${guid('ra')}',$,$,$,#2,(#3));`,
  ];
  /** B nests the shared part (and, in `extra`, a part of its own) under a housing of its own. */
  const NESTED = (extra = false) => [
    `#1=IFCPROJECT('${guid('pb')}',$,'B',$,$,$,$,$,$);`,
    proxy(2, 'housing', 'Housing'), proxy(3, 'part', 'Part'),
    ...(extra ? [proxy(5, 'own', 'Own part')] : []),
    `#4=IFCRELNESTS('${guid('rn')}',$,$,$,#2,(#3${extra ? ',#5' : ''}));`,
  ];
  const BOTH = ['IFCRELAGGREGATES', 'IFCRELNESTS'];

  it('IFC2X3: a nest does not add a second Decomposes parent to an aggregated part', async () => {
    const content = await merge(
      [await model('a', AGGREGATED, 'IFC2X3'), await model('b', NESTED(), 'IFC2X3')],
      { schema: 'IFC2X3' },
    );
    expect(parentsOf(content, 'IFCBUILDINGELEMENTPROXY', guid('part'), BOTH)).toEqual([2]);
    expect(content).not.toContain(guid('rn'));
    expectSingleParents(content, BOTH);
  });

  it('IFC4: the same merge keeps both, since Nests and Decomposes are separate inverses', async () => {
    const content = await merge([await model('a', AGGREGATED), await model('b', NESTED())]);
    expect(parentsOf(content, 'IFCBUILDINGELEMENTPROXY', guid('part'))).toEqual([2]);
    expect(parentsOf(content, 'IFCBUILDINGELEMENTPROXY', guid('part'), ['IFCRELNESTS'])).toHaveLength(1);
    expect(content).toContain(guid('rn'));
  });

  it.each(['IFC2X3', 'IFC4'] as const)('%s: a second nest of a unified part is stripped, keeping its new member', async (schema) => {
    const nestedA = [
      `#1=IFCPROJECT('${guid('pa')}',$,'A',$,$,$,$,$,$);`,
      proxy(2, 'unit', 'Unit'), proxy(3, 'part', 'Part'),
      `#4=IFCRELNESTS('${guid('na')}',$,$,$,#2,(#3));`,
    ];
    const content = await merge(
      [await model('a', nestedA, schema), await model('b', NESTED(true), schema)],
      { schema },
    );
    expect(parentsOf(content, 'IFCBUILDINGELEMENTPROXY', guid('part'), ['IFCRELNESTS'])).toEqual([2]);
    // B's rel stays for its own part, under B's housing.
    const housing = parentsOf(content, 'IFCBUILDINGELEMENTPROXY', guid('own'), ['IFCRELNESTS']);
    expect(housing).toHaveLength(1);
    expect(content.split('\n').find(l => l.startsWith(`#${housing[0]}=`))).toContain(guid('housing'));
    expectSingleParents(content, schema === 'IFC2X3' ? BOTH : ['IFCRELNESTS']);
  });
});
