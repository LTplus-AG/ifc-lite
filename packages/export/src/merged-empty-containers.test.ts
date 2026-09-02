/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `dropEmptyContainers` (#3643): the "Merge Projects" recipe step that container
 * MATCHING (`mergeSites` / `mergeBuildings` / `mergeStoreys`) leaves behind.
 *
 * Asserted through the public `MergedExporter`, on the emitted STEP text: a
 * container that ends up holding nothing is not written, nothing that survives
 * still names it, and a container only a later model fills is kept.
 */

import { describe, it, expect } from 'vitest';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';
import { asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';

type MockEntityRef = { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number };
type MockDataStore = Omit<IfcDataStore, 'entityIndex'> & {
  entityIndex: { byId: Map<number, MockEntityRef>; byType: Map<string, number[]> };
};
type MockMergeModelInput = Omit<MergeModelInput, 'dataStore'> & { dataStore: MockDataStore };

/** Build a minimal IfcDataStore from `[expressId, type, stepText]` lines. */
function buildModel(id: string, entries: Array<[number, string, string]>): MockMergeModelInput {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, MockEntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;
  for (const [expressId, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    byId.set(expressId, { expressId, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(expressId);
    parts.push(encoded);
    offset += encoded.byteLength;
  }
  const source = new Uint8Array(offset);
  let pos = 0;
  for (const part of parts) {
    source.set(part, pos);
    pos += part.byteLength;
  }
  const dataStore = {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source: asSourceBytes(source),
    entityIndex: { byId, byType },
  } as unknown as MockDataStore;
  return { id, name: id, dataStore };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A valid 22-char IFC GlobalId from a short, charset-safe label. */
const guid = (label: string): string => (label + '0'.repeat(22)).slice(0, 22);

/** Every `#N` reference in the output with no `#N=` definition. */
function danglingRefs(content: string): number[] {
  const defined = new Set<number>();
  for (const m of content.matchAll(/(^|\n)#(\d+)=/g)) defined.add(+m[2]);
  const dangling = new Set<number>();
  for (const m of content.matchAll(/#(\d+)/g)) {
    if (!defined.has(+m[1])) dangling.add(+m[1]);
  }
  return [...dangling].sort((a, b) => a - b);
}

/**
 * Project → Site → Building → two storeys; the wall sits on the storey named by
 * `wallStorey`, so the other storey holds nothing.
 */
function tree(salt: string, wallStorey: 4 | 5): MockMergeModelInput {
  return buildModel(`m${salt}`, [
    [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('p' + salt)}',$,'P',$,$,$,$,$,$);`],
    [2, 'IFCSITE', `#2=IFCSITE('${guid('s' + salt)}',$,'Site',$,$,$,$,$,$,$,$,$,$,$);`],
    [3, 'IFCBUILDING', `#3=IFCBUILDING('${guid('b' + salt)}',$,'Building',$,$,$,$,$,$,$,$,$);`],
    [4, 'IFCBUILDINGSTOREY', `#4=IFCBUILDINGSTOREY('${guid('g' + salt)}',$,'Level 0',$,$,$,$,$,$,0.);`],
    [5, 'IFCBUILDINGSTOREY', `#5=IFCBUILDINGSTOREY('${guid('f' + salt)}',$,'Level 1',$,$,$,$,$,$,3.);`],
    [6, 'IFCWALL', `#6=IFCWALL('${guid('w' + salt)}',$,'Wall',$,$,$,$,$,$);`],
    [7, 'IFCRELAGGREGATES', `#7=IFCRELAGGREGATES('${guid('a' + salt)}',$,$,$,#1,(#2));`],
    [8, 'IFCRELAGGREGATES', `#8=IFCRELAGGREGATES('${guid('c' + salt)}',$,$,$,#2,(#3));`],
    [9, 'IFCRELAGGREGATES', `#9=IFCRELAGGREGATES('${guid('d' + salt)}',$,$,$,#3,(#4,#5));`],
    [10, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', `#10=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('e' + salt)}',$,$,$,(#6),#${wallStorey});`],
  ]);
}

const OPTIONS = { schema: 'IFC4' as const, projectStrategy: 'keep-first' as const };

describe('MergedExporter dropEmptyContainers', () => {
  it('drops a storey no model fills, and leaves nothing naming it', () => {
    const merged = new MergedExporter([tree('0', 4), tree('1', 4)] as MergeModelInput[])
      .export({ ...OPTIONS, dropEmptyContainers: true });
    const content = decode(merged.content);

    expect(merged.stats.droppedContainerCount).toBe(1);
    expect(content).not.toContain("'Level 1'");
    expect(content).toContain("'Level 0'");
    // Its site and building only hold a storey, and survive on that alone.
    expect(content).toContain('=IFCSITE(');
    expect(content).toContain('=IFCBUILDING(');
    // The aggregation that listed both storeys is narrowed, not withheld.
    const storeyId = /#(\d+)=IFCBUILDINGSTOREY/.exec(content)![1];
    expect(content).toContain(`,(#${storeyId}));`);
    expect(danglingRefs(content)).toEqual([]);
  });

  it('keeps a container that only a later model fills', () => {
    // Model A's Level 1 is empty; model B's same-named storey carries the wall
    // and unifies onto it. Emptiness is a fact about the MERGED model.
    const merged = new MergedExporter([tree('0', 4), tree('1', 5)] as MergeModelInput[])
      .export({ ...OPTIONS, dropEmptyContainers: true });
    const content = decode(merged.content);

    expect(merged.stats.droppedContainerCount).toBe(0);
    expect(content).toContain("'Level 1'");
    expect(danglingRefs(content)).toEqual([]);
  });

  it('is off by default and inert when nothing is empty', () => {
    const models = () => [tree('0', 4), tree('1', 5)] as MergeModelInput[];
    const baseline = new MergedExporter(models()).export(OPTIONS);
    const asked = new MergedExporter(models()).export({ ...OPTIONS, dropEmptyContainers: true });

    expect(baseline.stats.droppedContainerCount).toBe(0);
    // The run that ASKED is the one that could misreport: with the flag absent
    // the count is 0 by construction, so only this assertion can catch a planner
    // that claims a drop it did not make.
    expect(asked.stats.droppedContainerCount).toBe(0);
    // Byte-identical: asking for the drop cannot perturb a merge with nothing
    // to drop (the header is deterministic apart from the timestamp, which both
    // exports take in the same test tick).
    expect(decode(asked.content).split('DATA;')[1]).toBe(decode(baseline.content).split('DATA;')[1]);
  });

  it('keeps an empty container a non-relationship entity names', () => {
    // Nothing can narrow a reference from a non-IfcRel entity, so dropping the
    // space would leave a dangling `#ref` — it stays instead.
    const model = buildModel('m0', [
      [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('p')}',$,'P',$,$,$,$,$,$);`],
      [2, 'IFCSPACE', `#2=IFCSPACE('${guid('sp')}',$,'Space',$,$,$,$,$,$,$,$);`],
      [3, 'IFCRELAGGREGATES', `#3=IFCRELAGGREGATES('${guid('a')}',$,$,$,#1,(#2));`],
      [4, 'IFCPRESENTATIONLAYERASSIGNMENT', '#4=IFCPRESENTATIONLAYERASSIGNMENT(\'L\',$,(#2),$);'],
    ]);
    const merged = new MergedExporter([model] as MergeModelInput[])
      .export({ ...OPTIONS, dropEmptyContainers: true });
    const content = decode(merged.content);

    expect(merged.stats.droppedContainerCount).toBe(0);
    expect(content).toContain('=IFCSPACE(');
    expect(danglingRefs(content)).toEqual([]);
  });

  it('drops an empty space and the relationships that only named it', () => {
    const model = buildModel('m0', [
      [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('p')}',$,'P',$,$,$,$,$,$);`],
      [2, 'IFCBUILDINGSTOREY', `#2=IFCBUILDINGSTOREY('${guid('g')}',$,'Level 0',$,$,$,$,$,$,0.);`],
      [3, 'IFCSPACE', `#3=IFCSPACE('${guid('sp')}',$,'Empty room',$,$,$,$,$,$,$,$);`],
      [4, 'IFCWALL', `#4=IFCWALL('${guid('w')}',$,'Wall',$,$,$,$,$,$);`],
      [5, 'IFCRELAGGREGATES', `#5=IFCRELAGGREGATES('${guid('a')}',$,$,$,#1,(#2));`],
      [6, 'IFCRELAGGREGATES', `#6=IFCRELAGGREGATES('${guid('c')}',$,$,$,#2,(#3));`],
      [7, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', `#7=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('e')}',$,$,$,(#4),#2);`],
      [8, 'IFCPROPERTYSET', `#8=IFCPROPERTYSET('${guid('ps')}',$,'Pset_SpaceCommon',$,());`],
      [9, 'IFCRELDEFINESBYPROPERTIES', `#9=IFCRELDEFINESBYPROPERTIES('${guid('r')}',$,$,$,(#3),#8);`],
    ]);
    const merged = new MergedExporter([model] as MergeModelInput[])
      .export({ ...OPTIONS, dropEmptyContainers: true });
    const content = decode(merged.content);

    expect(merged.stats.droppedContainerCount).toBe(1);
    expect(content).not.toContain('=IFCSPACE(');
    // The aggregation and the property assignment named only the dropped space,
    // so both go with it — while the storey that holds the wall stays.
    expect(content).not.toContain('=IFCRELDEFINESBYPROPERTIES(');
    expect(content).toContain('=IFCBUILDINGSTOREY(');
    expect(content).toContain('=IFCWALL(');
    // The property set itself is left behind, unreferenced but valid.
    expect(content).toContain('=IFCPROPERTYSET(');
    expect(danglingRefs(content)).toEqual([]);
  });
});
