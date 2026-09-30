/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Copying an assembly with its parts, and refusing a copy whose parent frame
 * cannot be tied to its storey (#6232 C3 follow-up).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { copyProductInStore, createCopyContext, copyRefusal, productStoreyOrigin } from './copy-product.js';
import { asRef } from './style-entity-reader.js';

const STEP = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#42);
#42=IFCAXIS2PLACEMENT3D(#43,$,$);
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSITE('3wdauVJT5Fx9drrREiDq10',$,'S',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#60=IFCBUILDING('3wdauVJT5Fx9drrREiDq11',$,'B',$,$,$,$,$,.ELEMENT.,$,$,$);
#61=IFCRELAGGREGATES('3wdauVJT5Fx9drrREiDq12',$,$,$,#1,(#50));
#62=IFCRELAGGREGATES('3wdauVJT5Fx9drrREiDq13',$,$,$,#50,(#60));
#63=IFCRELAGGREGATES('3wdauVJT5Fx9drrREiDq14',$,$,$,#60,(#40));
#90=IFCDIRECTION((0.,1.,0.));
#100=IFCELEMENTASSEMBLY('3wdauVJT5Fx9drrREiDq01',$,'Assembly',$,$,#101,$,$,$,$);
#101=IFCLOCALPLACEMENT(#41,#102);
#102=IFCAXIS2PLACEMENT3D(#103,$,$);
#103=IFCCARTESIANPOINT((2.,3.,0.));
#110=IFCBEAM('3wdauVJT5Fx9drrREiDq02',$,'Part A',$,$,#111,$,$,$);
#111=IFCLOCALPLACEMENT(#101,#112);
#112=IFCAXIS2PLACEMENT3D(#113,$,$);
#113=IFCCARTESIANPOINT((1.,0.,0.));
#115=IFCBEAM('3wdauVJT5Fx9drrREiDq03',$,'Part B',$,$,#116,$,$,$);
#116=IFCLOCALPLACEMENT(#101,#117);
#117=IFCAXIS2PLACEMENT3D(#118,$,$);
#118=IFCCARTESIANPOINT((0.,1.,0.));
#125=IFCBEAM('3wdauVJT5Fx9drrREiDq04',$,'Sub part',$,$,#126,$,$,$);
#126=IFCLOCALPLACEMENT(#116,#127);
#127=IFCAXIS2PLACEMENT3D(#128,$,$);
#128=IFCCARTESIANPOINT((0.,0.5,0.));
#120=IFCRELAGGREGATES('3wdauVJT5Fx9drrREiDq05',$,$,$,#100,(#110,#115));
#121=IFCRELAGGREGATES('3wdauVJT5Fx9drrREiDq06',$,$,$,#115,(#125));
#130=IFCRELCONTAINEDINSPATIALSTRUCTURE('3wdauVJT5Fx9drrREiDq07',$,$,$,(#100,#200,#300),#40);
#205=IFCLOCALPLACEMENT(#41,#206);
#206=IFCAXIS2PLACEMENT3D(#207,$,#90);
#207=IFCCARTESIANPOINT((0.,0.,0.));
#200=IFCBEAM('3wdauVJT5Fx9drrREiDq08',$,'Turned parent',$,$,#201,$,$,$);
#201=IFCLOCALPLACEMENT(#205,#202);
#202=IFCAXIS2PLACEMENT3D(#203,$,$);
#203=IFCCARTESIANPOINT((1.,0.,0.));
#305=IFCLOCALPLACEMENT($,#206);
#300=IFCBEAM('3wdauVJT5Fx9drrREiDq09',$,'Detached parent',$,$,#301,$,$,$);
#301=IFCLOCALPLACEMENT(#305,#202);
ENDSEC;
END-ISO-10303-21;
`;

let store: IfcDataStore;
let editor: StoreEditor;
const created = (type: string) => editor.getNewEntities().filter((e) => e.type.toUpperCase() === type.toUpperCase());
const attr = (id: number, index: number) => editor.getNewEntity(id)?.attributes[index];
const ref = (id: number, index: number) => asRef(attr(id, index));
function locationOf(id: number): number[] {
  const axis = ref(ref(id, 5)!, 1)!;
  return attr(ref(axis, 0)!, 0) as number[];
}

beforeEach(async () => {
  const bytes = new TextEncoder().encode(STEP);
  store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  editor = new StoreEditor(store, new MutablePropertyView(null, 'm'));
});

describe('copying an assembly (#6232 C3)', () => {
  it('copies the parts at every depth, re-creates the aggregation, gives fresh GlobalIds', () => {
    const result = copyProductInStore(createCopyContext(store, editor), 100, { offset: [10, 0, 0] });
    expect(result.partIds).toHaveLength(3);
    const beams = created('IfcBeam').map((e) => e.expressId);
    expect(beams.sort()).toEqual([...result.partIds].sort());

    // Assembly -> (A, B) and B -> (sub part), both new IfcRelAggregates between the copies.
    const rels = created('IfcRelAggregates').map((r) => [asRef(r.attributes[4]), (r.attributes[5] as string[]).map((v) => asRef(v))]);
    const byName = (name: string) => result.partIds.find((id) => attr(id, 2) === name)!;
    expect(rels).toContainEqual([result.copyId, [byName('Part A'), byName('Part B')]]);
    expect(rels).toContainEqual([byName('Part B'), [byName('Sub part')]]);
    expect(rels).toHaveLength(2);

    // Each part keeps its place under its own assembly's copy: unchanged local location, new parent.
    const parentOf = (id: number) => ref(ref(id, 5)!, 0);
    expect(parentOf(byName('Part A'))).toBe(ref(result.copyId, 5));
    expect(locationOf(byName('Part A'))).toEqual([1, 0, 0]);
    expect(parentOf(byName('Sub part'))).toBe(ref(byName('Part B'), 5));
    expect(locationOf(byName('Sub part'))).toEqual([0, 0.5, 0]);
    expect(locationOf(result.copyId)).toEqual([12, 3, 0]);

    // Fresh GlobalIds, and only the assembly is contained in the storey.
    const guids = [result.copyId, ...result.partIds].map((id) => attr(id, 0) as string);
    expect(new Set(guids).size).toBe(4);
    for (const guid of guids) expect(STEP.includes(`'${guid}'`)).toBe(false);
    const contained = created('IfcRelContainedInSpatialStructure').flatMap((r) => (r.attributes[4] as string[]).map((v) => asRef(v)));
    expect(contained).toEqual([result.copyId]);
    expect(result.meshed).toEqual([result.copyId, ...result.partIds]);
  });

  it('copies an assembly onto another storey with its parts', () => {
    const point = editor.addEntity('IfcCartesianPoint', [[0, 0, 3]]);
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point.expressId}`, null, null]);
    const upper = editor.addEntity('IfcLocalPlacement', ['#41', `#${axis.expressId}`]);
    const storey = editor.addEntity('IfcBuildingStorey', ['0$abcdefghijklmnopqrstu', null, 'Upper', null, null, `#${upper.expressId}`, null, null, '.ELEMENT.', 3]);
    const result = copyProductInStore(createCopyContext(store, editor), 100, { targetStoreyId: storey.expressId });
    expect(ref(ref(result.copyId, 5)!, 0)).toBe(upper.expressId);
    expect(result.partIds).toHaveLength(3);
    const partA = result.partIds.find((id) => attr(id, 2) === 'Part A')!;
    expect(ref(ref(partA, 5)!, 0)).toBe(ref(result.copyId, 5));
  });

  it('refuses a part on its own: it is copied with its assembly', () => {
    const ctx = createCopyContext(store, editor);
    expect(copyRefusal(ctx, 110)).toMatch(/assembly/);
    expect(() => copyProductInStore(ctx, 125)).toThrow(/assembly/);
    expect(editor.getNewEntities()).toHaveLength(0);
  });
});

describe('a parent frame that is not tied to the storey (#6232 C3, review)', () => {
  it('a parent turned 90 degrees and chained to the storey: the copy moves in the STOREY frame', () => {
    // Element at local (1, 0) under a parent turned 90 degrees: storey (0, 1). Moved +2 m in x -> (2, 1) -> local (1, -2).
    const result = copyProductInStore(createCopyContext(store, editor), 200, { offset: [2, 0, 0] });
    const [x, y] = locationOf(result.copyId);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(-2);
    // The paste grip is the same storey-frame point the preview uses.
    const origin = productStoreyOrigin(createCopyContext(store, editor), 200)!;
    expect(origin.origin[0]).toBeCloseTo(0);
    expect(origin.origin[1]).toBeCloseTo(1);
  });

  it('a turned parent that never reaches the storey placement: the copy is refused, nothing is written', () => {
    const ctx = createCopyContext(store, editor);
    expect(() => copyProductInStore(ctx, 300, { offset: [2, 0, 0] })).toThrow(/not tied to its storey/);
    expect(() => productStoreyOrigin(ctx, 300)).toThrow(/not tied to its storey/);
    expect(editor.getNewEntities()).toHaveLength(0);
  });
});
