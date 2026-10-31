/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `copyProductInStore(…, { shape: 'own' })` (#8447): a copy of an element read
 * from the file gets its own shape records, so it can be edited apart from its
 * source. Sharing stays the default; a shape over the bound refuses the copy.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter, editOwnershipRefusal } from '@ifc-lite/export';
import { copyProductInStore, createCopyContext } from './copy-product.js';
import { copyBatchInStore } from './copy-batch.js';
import { MAX_CLONED_SHAPE_RECORDS } from './copy-shape.js';
import { parseStepAttributeList } from './step-record-attrs.js';
import { asRef } from './style-entity-reader.js';

const SAMPLE = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const WALL = 1222;
const WALL_SHAPE = 1230; // IFCPRODUCTDEFINITIONSHAPE($,$,(#1251,#1261))
const BODY_CONTEXT = 15;
const AXIS_CONTEXT = 27;

let store: IfcDataStore;
let view: MutablePropertyView;
let editor: StoreEditor;

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
}
const exported = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-31T00:00:00' }).content);
const attr = (id: number, index: number) => editor.getNewEntity(id)?.attributes[index];
const refs = (value: unknown) => (value as unknown[]).map(asRef);

beforeEach(async () => {
  store = await parse(readFileSync(SAMPLE, 'utf8'));
  view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  editor = new StoreEditor(store, view);
});

describe("copyProductInStore shape: 'own' (#8447)", () => {
  it('gives a copy of a file wall its own shape records, with the contexts still shared', () => {
    const { copyId } = copyProductInStore(createCopyContext(store, editor), WALL, { offset: [0, 3, 0] }, { shape: 'own' });
    const shape = asRef(attr(copyId, 6))!;
    expect(shape).not.toBe(WALL_SHAPE);
    const [axisRep, bodyRep] = refs(attr(shape, 2)) as number[];
    expect([axisRep, bodyRep].every((id) => editor.getNewEntity(id)?.type.toUpperCase() === 'IFCSHAPEREPRESENTATION')).toBe(true);
    expect([asRef(attr(axisRep, 0)), asRef(attr(bodyRep, 0))]).toEqual([AXIS_CONTEXT, BODY_CONTEXT]);
    // The solid, its profile and its point list are new records too, read with their exact STEP types.
    const solid = asRef((attr(bodyRep, 3) as unknown[])[0])!;
    expect(editor.getNewEntity(solid)?.type.toUpperCase()).toBe('IFCEXTRUDEDAREASOLID');
    expect(attr(solid, 3)).toEqual({ real: 3 });
    const profile = asRef(attr(solid, 0))!;
    const curve = asRef(attr(profile, 2))!;
    expect(editor.getNewEntity(asRef(attr(curve, 0))!)?.attributes[0]).toEqual([[{ real: 0 }, { real: 0 }], [{ real: 0 }, { real: 0.1 }], [{ real: 10 }, { real: 0.1 }], [{ real: 10 }, { real: 0 }], [{ real: 0 }, { real: 0 }]]);
  });

  it('lets the copy be edited apart: the ownership check refuses a shared copy and allows an own one', () => {
    const ctx = createCopyContext(store, editor);
    const shared = copyProductInStore(ctx, WALL, { offset: [0, 3, 0] });
    const own = copyProductInStore(ctx, WALL, { offset: [0, 6, 0] }, { shape: 'own' });
    const sharedSolid = 1260;
    const ownBody = (refs(attr(asRef(attr(own.copyId, 6))!, 2)) as number[])[1];
    const ownSolid = asRef((attr(ownBody, 3) as unknown[])[0])!;
    editor.setPositionalAttribute(sharedSolid, 3, { real: 2.5 });
    editor.setPositionalAttribute(ownSolid, 3, { real: 2.5 });
    expect(editOwnershipRefusal(store, view, [sharedSolid], new Set([shared.copyId]))).not.toBeNull();
    expect(editOwnershipRefusal(store, view, [ownSolid], new Set([own.copyId]))).toBeNull();
  });

  it('keeps sharing by default', () => {
    const { copyId } = copyProductInStore(createCopyContext(store, editor), WALL, { offset: [0, 3, 0] });
    expect(asRef(attr(copyId, 6))).toBe(WALL_SHAPE);
  });

  it('is reachable from copyBatchInStore, for the copies and the Duplicate path alike', () => {
    const [plain] = copyBatchInStore(store, editor, [WALL], [{ offset: [0, 3, 0] }], { shape: 'own' });
    const [named] = copyBatchInStore(store, editor, [WALL], [{ offset: [0, 6, 0] }], { shape: 'own', duplicate: {} });
    const [shared] = copyBatchInStore(store, editor, [WALL], [{ offset: [0, 9, 0] }]);
    expect(asRef(attr(plain.copyId, 6))).not.toBe(WALL_SHAPE);
    expect(asRef(attr(named.copyId, 6))).not.toBe(WALL_SHAPE);
    expect(asRef(attr(shared.copyId, 6))).toBe(WALL_SHAPE);
  });

  it('exports an own copy that parses back with two walls, two bodies and the same records', async () => {
    const before = exported().length;
    const shared = (() => {
      copyProductInStore(createCopyContext(store, editor), WALL, { offset: [0, 3, 0] });
      return exported().length - before;
    })();
    store = await parse(readFileSync(SAMPLE, 'utf8'));
    view = new MutablePropertyView(null, 'm');
    editor = new StoreEditor(store, view);
    copyProductInStore(createCopyContext(store, editor), WALL, { offset: [0, 3, 0] }, { shape: 'own' });
    const text = exported();
    const own = text.length - before;
    // The file-size effect, for the PR: the shape records of the wall, its openings and windows again.
    console.info(`copy of the sample wall with its windows: shared +${shared} bytes, own +${own} bytes`);
    expect(own).toBeGreaterThan(shared);
    const reparsed = await parse(text);
    const ids = (type: string) => reparsed.entityIndex.byType.get(type) ?? [];
    expect(ids('IFCWALL')).toHaveLength(2);
    expect(ids('IFCEXTRUDEDAREASOLID').length).toBeGreaterThan(2);
    expect(text).toMatch(/IFCEXTRUDEDAREASOLID\(#\d+,#\d+,#\d+,3\.\);[\s\S]*IFCEXTRUDEDAREASOLID\(#\d+,#\d+,#\d+,3\.\);/);
  });

  it('refuses the copy, rather than sharing, when a file shape is over the bound', async () => {
    // A file wall whose body is a polyline of more points than the bound.
    const n = MAX_CLONED_SHAPE_RECORDS + 1, first = 100_000;
    const points = Array.from({ length: n }, (_, i) => `#${first + i}=IFCCARTESIANPOINT((${i}.,0.));`).join('\n');
    const big = [
      points,
      `#${first + n}=IFCPOLYLINE((${Array.from({ length: n }, (_, i) => `#${first + i}`).join(',')}));`,
      `#${first + n + 1}=IFCSHAPEREPRESENTATION(#${AXIS_CONTEXT},'Axis','Curve2D',(#${first + n}));`,
      `#${first + n + 2}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${first + n + 1}));`,
    ].join('\n');
    const text = readFileSync(SAMPLE, 'utf8').replace('ENDSEC;\nEND-ISO-10303-21;', `${big}\nENDSEC;\nEND-ISO-10303-21;`);
    store = await parse(text);
    view = new MutablePropertyView(null, 'm');
    editor = new StoreEditor(store, view);
    editor.setPositionalAttribute(WALL, 6, `#${first + n + 2}`);
    const ctx = createCopyContext(store, editor);
    expect(() => copyProductInStore(ctx, WALL, { offset: [0, 3, 0] }, { shape: 'own' })).toThrow(/too large to copy/);
    expect(asRef(attr(copyProductInStore(ctx, WALL, { offset: [0, 3, 0] }).copyId, 6))).toBe(first + n + 2);
  });
});

describe('parseStepAttributeList', () => {
  it('keeps references, integers, reals, enums, strings and typed values apart', () => {
    expect(parseStepAttributeList("#12,12,12.,1.E-3,.T.,.AREA.,$,*,'it''s \\X2\\00FC\\X0\\',IFCLENGTHMEASURE(2.5),IFCBOOLEAN(.F.),((1,2,3),(#4))"))
      .toEqual(['#12', 12, { real: 12 }, { real: 0.001 }, '.T.', '.AREA.', null, '*', "it's ü",
        { typed: { type: 'IFCLENGTHMEASURE', value: 2.5 } }, { typed: { type: 'IFCBOOLEAN', value: false } }, [[1, 2, 3], ['#4']]]);
  });
});

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
describe.skipIf(!existsSync(WASM_PATH))("an own-shape copy meshes like its source (#8447)", () => {
  it('the copy has the same volume, cut by its windows', async () => {
    const { copyId } = copyProductInStore(createCopyContext(store, editor), WALL, { offset: [0, 3, 0] }, { shape: 'own' });
    const { IfcAPI, initSync } = await import('@ifc-lite/wasm');
    initSync({ module: readFileSync(WASM_PATH) });
    const api = new IfcAPI();
    const bytes = new TextEncoder().encode(exported());
    api.setComputeGeometryHashes(1e-3);
    const pre = api.buildPrePassOnce(bytes);
    try {
      const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
      const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
      try {
        const volumes = new Map<number, number>();
        for (let i = 0; i < collection.geometryHashIds.length; i++) volumes.set(collection.geometryHashIds[i], collection.geometryVolumeValues[i]);
        expect(volumes.get(WALL)!).toBeGreaterThan(0);
        expect(volumes.get(copyId)).toBeCloseTo(volumes.get(WALL)!, 6);
      } finally {
        collection.free();
      }
    } finally {
      api.clearPrePassCache();
    }
  });
});
