/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A merge keeps a GlobalId-unified entity in one relationship per
 * single-valued inverse (#5774). Relationships are never unified, so when a
 * later model repeats an IfcPropertySet by GlobalId, its own
 * IfcRelDefinesByProperties still names it. In IFC2X3
 * `IfcPropertySetDefinition.PropertyDefinitionOf` is `SET [0:1]`, so the
 * unified property set ended up with two. The IfcOpenShell version of this
 * check, on `ara3d/duplex.ifc`, is in `ifcopenshell-schema-conformance.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MergedExporter, type MergeExportOptions, type MergeModelInput } from './merged-exporter.js';

const guid = (label: string): string => (label + '0'.repeat(22)).slice(0, 22);

async function model(id: string, lines: string[], schema = 'IFC2X3'): Promise<MergeModelInput> {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('m.ifc','2026-01-01T00:00:00',(''),(''),'t','t','');", `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
  return { id, name: id, dataStore };
}

async function mergeWithStats(models: MergeModelInput[], options: Partial<MergeExportOptions> = {}): Promise<{ content: string; warnings: string[] }> {
  const result = new MergedExporter(models).export({ schema: 'IFC2X3', ...options });
  return { content: new TextDecoder().decode(result.content), warnings: result.stats.warnings };
}

async function merge(models: MergeModelInput[], options: Partial<MergeExportOptions> = {}): Promise<string> {
  return (await mergeWithStats(models, options)).content;
}

/** Final id of the line whose GlobalId is `globalId`. */
function idOf(content: string, globalId: string): number {
  const line = content.split('\n').find(l => l.includes(`('${globalId}'`));
  expect(line, `${globalId} is in the output`).toBeDefined();
  return Number(/^#(\d+)=/.exec(line!)![1]);
}

/** Every written IfcRelDefinesByProperties or IfcRelOverridesProperties, as its RelatedObjects and RelatingPropertyDefinition. */
function definers(content: string): Array<{ objects: number[]; pset: number }> {
  return [...content.matchAll(/^#\d+=IFCREL(?:DEFINESBY|OVERRIDES)PROPERTIES\('[^']*',[^,]*,[^,]*,[^,]*,\(([^)]*)\),#(\d+)[,)]/gm)].map(m => ({
    objects: [...m[1].matchAll(/#(\d+)/g)].map(r => Number(r[1])),
    pset: Number(m[2]),
  }));
}

const proxy = (id: number, tag: string) => `#${id}=IFCBUILDINGELEMENTPROXY('${guid(tag)}',$,'${tag}',$,$,$,$,$,$);`;
/** A property set with GlobalId `pset` defining the proxies `objects` (ids from 10). */
const DEFINED = (project: string, objects: string[], relTag: string, override = false) => [
  `#1=IFCPROJECT('${guid(project)}',$,'P',$,$,$,$,$,$);`,
  ...objects.map((tag, i) => proxy(10 + i, tag)),
  "#2=IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('R'),$);",
  `#3=IFCPROPERTYSET('${guid('pset')}',$,'Pset_Test',$,(#2));`,
  override
    ? `#4=IFCRELOVERRIDESPROPERTIES('${guid(relTag)}',$,$,$,(${objects.map((_, i) => `#${10 + i}`).join(',')}),#3,(#2));`
    : `#4=IFCRELDEFINESBYPROPERTIES('${guid(relTag)}',$,$,$,(${objects.map((_, i) => `#${10 + i}`).join(',')}),#3);`,
];

describe('MergedExporter keeps one IfcRelDefinesByProperties per property set in IFC2X3 (#5774)', () => {
  it('does not write a later model\'s definer of a property set it repeats by GlobalId', async () => {
    const content = await merge([
      await model('a', DEFINED('pa', ['wall'], 'ra')),
      await model('b', DEFINED('pb', ['wall'], 'rb')),
    ]);
    const pset = idOf(content, guid('pset'));
    expect(definers(content).filter(rel => rel.pset === pset)).toEqual([{ objects: [idOf(content, guid('wall'))], pset }]);
    expect(content).not.toContain(guid('rb'));
  });

  it('folds the objects only the later model defines into the one written definer', async () => {
    // B repeats the wall and the property set, and also defines a door of its
    // own with it. Dropping B's rel would lose the door's definition; keeping
    // it gives the property set a second definer. The door joins A's rel.
    const content = await merge([
      await model('a', DEFINED('pa', ['wall'], 'ra')),
      await model('b', DEFINED('pb', ['wall', 'door'], 'rb')),
    ]);
    const pset = idOf(content, guid('pset'));
    expect(definers(content).filter(rel => rel.pset === pset)).toEqual([
      { objects: [idOf(content, guid('wall')), idOf(content, guid('door'))], pset },
    ]);
    expect(content).toContain(guid('ra'));
    expect(content).not.toContain(guid('rb'));
  });

  it('folds a third model into the same definer, once per object', async () => {
    const content = await merge([
      await model('a', DEFINED('pa', ['wall'], 'ra')),
      await model('b', DEFINED('pb', ['wall', 'door'], 'rb')),
      await model('c', DEFINED('pc', ['door', 'slab'], 'rc')),
    ]);
    const pset = idOf(content, guid('pset'));
    expect(definers(content).filter(rel => rel.pset === pset)).toEqual([
      { objects: ['wall', 'door', 'slab'].map(tag => idOf(content, guid(tag))), pset },
    ]);
  });

  it('keeps the later definer when the primary\'s is not written (visibleOnly, its object hidden)', async () => {
    // A's only defined object is hidden, so A's rel is withheld and B's rel is
    // the property set's only definer in the output.
    const content = await merge([
      await model('a', [...DEFINED('pa', ['wall'], 'ra'), proxy(11, 'kept')]),
      await model('b', DEFINED('pb', ['door'], 'rb')),
    ], { visibleOnly: true, hiddenEntityIdsByModel: new Map([['a', new Set([10])]]) });
    expect(content).not.toContain(guid('ra'));
    const pset = idOf(content, guid('pset'));
    expect(definers(content).filter(rel => rel.pset === pset)).toEqual([{ objects: [idOf(content, guid('door'))], pset }]);
  });

  it.each([
    ['an IfcRelOverridesProperties, whose WR1 allows one object', true],
    ['a definer of another relationship type', false],
  ])('does not fold into %s, and reports the object that lost its definition', async (_, ownerOverrides) => {
    const { content, warnings } = await mergeWithStats([
      await model('a', DEFINED('pa', ['wall'], 'ra', ownerOverrides)),
      await model('b', DEFINED('pb', ['door'], 'rb', true)),
    ]);
    const pset = idOf(content, guid('pset'));
    expect(definers(content).filter(rel => rel.pset === pset)).toEqual([{ objects: [idOf(content, guid('wall'))], pset }]);
    expect(content).not.toContain(guid('rb'));
    expect(warnings.filter(w => w.includes('lost that relationship'))).toHaveLength(1);
  });

  it('IFC4: keeps both, since DefinesOccurrence is SET [0:?] there', async () => {
    const content = await merge([
      await model('a', DEFINED('pa', ['wall'], 'ra'), 'IFC4'),
      await model('b', DEFINED('pb', ['wall', 'door'], 'rb'), 'IFC4'),
    ], { schema: 'IFC4' });
    const pset = idOf(content, guid('pset'));
    expect(definers(content).filter(rel => rel.pset === pset)).toHaveLength(2);
  });
});
