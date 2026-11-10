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

  it('refuses a cyclic shape atomically instead of keeping a reference to the original (#8447)', () => {
    editor.setPositionalAttribute(1260, 0, '#1260');
    const before = exported();
    expect(() => copyProductInStore(createCopyContext(store, editor), WALL, {}, { shape: 'own' })).toThrow(/cyclic shape/);
    expect(exported()).toBe(before);
  });

  it.each([WALL_SHAPE, 1252])('refuses a missing root or descendant #%s atomically (#8447)', async (missing) => {
    // Parse a genuinely dangling STEP reference; the parser index is read-only.
    const text = readFileSync(SAMPLE, 'utf8').split('\n').filter(line => !line.startsWith(`#${missing}=`)).join('\n');
    store = await parse(text);
    view = new MutablePropertyView(null, 'm');
    editor = new StoreEditor(store, view);
    const before = exported();
    expect(() => copyProductInStore(createCopyContext(store, editor), WALL, {}, { shape: 'own' })).toThrow(/unreadable shape record/);
    expect(exported()).toBe(before);
  });

  it('preserves IFC4 line and arc segment indices through own-copy export (#8447)', async () => {
    const source = readFileSync(SAMPLE, 'utf8')
      .replace('#1253=IFCINDEXEDPOLYCURVE(#1252,$,.F.);', '#1253=IFCINDEXEDPOLYCURVE(#1252,(IFCLINEINDEX((1,2)),IFCARCINDEX((2,3,4)),IFCLINEINDEX((4,5))),.F.);');
    store = await parse(source);
    view = new MutablePropertyView(null, 'm');
    editor = new StoreEditor(store, view);
    const { copyId } = copyProductInStore(createCopyContext(store, editor), WALL, {}, { shape: 'own' });
    const body = refs(attr(asRef(attr(copyId, 6))!, 2))[1]!;
    const solid = asRef((attr(body, 3) as unknown[])[0])!;
    const curve = asRef(attr(asRef(attr(solid, 0))!, 2))!;
    expect(attr(curve, 1)).toEqual([
      { typed: { type: 'IFCLINEINDEX', value: [1, 2] } },
      { typed: { type: 'IFCARCINDEX', value: [2, 3, 4] } },
      { typed: { type: 'IFCLINEINDEX', value: [4, 5] } },
    ]);
    const text = exported();
    expect(text).toContain(`#${curve}=IFCINDEXEDPOLYCURVE(`);
    expect(text).toContain('(IFCLINEINDEX((1,2)),IFCARCINDEX((2,3,4)),IFCLINEINDEX((4,5)))');
    const reparsed = await parse(text);
    expect(reparsed.entityIndex.byType.get('IFCWALL')).toHaveLength(2);
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
    const n = 50_001, first = 100_000;
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
    const before = exported();
    expect(() => copyProductInStore(ctx, WALL, { offset: [0, 3, 0] }, { shape: 'own' })).toThrow(/too large to copy/);
    expect(exported()).toBe(before);
    expect(asRef(attr(copyProductInStore(ctx, WALL, { offset: [0, 3, 0] }).copyId, 6))).toBe(first + n + 2);
  }, 30_000); // Parse and export 50,001 real IFC points; this is a bound/atomicity assertion, not a timing ratchet.
});

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
describe.skipIf(!existsSync(WASM_PATH))("an own-shape copy meshes like its source (#8447; build WASM with pnpm build:wasm)", () => {
  it.each([false, true])('resizing the own copy leaves source geometry unchanged (indexed segments: %s)', async (indexed) => {
    if (indexed) {
      const text = readFileSync(SAMPLE, 'utf8')
        .replace('#1250=IFCINDEXEDPOLYCURVE(#1249,$,.F.);', '#1250=IFCINDEXEDPOLYCURVE(#1249,(IFCLINEINDEX((1,2))),.F.);')
        .replace('#1253=IFCINDEXEDPOLYCURVE(#1252,$,.F.);', '#1253=IFCINDEXEDPOLYCURVE(#1252,(IFCLINEINDEX((1,2,3,4,5))),.F.);');
      store = await parse(text);
      view = new MutablePropertyView(null, 'm');
      editor = new StoreEditor(store, view);
    }
    const { copyId } = copyProductInStore(createCopyContext(store, editor), WALL, { offset: [0, 3, 0] }, { shape: 'own' });
    const { IfcAPI, initSync } = await import('@ifc-lite/wasm');
    initSync({ module: readFileSync(WASM_PATH) });
    const measure = () => {
      const api = new IfcAPI();
      try {
        const bytes = new TextEncoder().encode(exported());
        api.setComputeGeometryHashes(1e-3);
        const pre = api.buildPrePassOnce(bytes);
        const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
        const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
          pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
        try {
          const ids = collection.geometryHashIds;
          const values = collection.geometryVolumeValues;
          return new Map(Array.from(ids, (id, i) => [id, values[i]] as const));
        } finally {
          collection.free();
        }
      } finally {
        api.clearPrePassCache();
        api.free();
      }
    };
    const before = measure();
    expect(before.get(WALL)!).toBeGreaterThan(0);
    expect(before.get(copyId)).toBeCloseTo(before.get(WALL)!, 6);
    const body = refs(attr(asRef(attr(copyId, 6))!, 2))[1]!;
    const solid = asRef((attr(body, 3) as unknown[])[0])!;
    editor.setPositionalAttribute(solid, 3, { real: 2.5 });
    const after = measure();
    expect(after.get(WALL)).toBeCloseTo(before.get(WALL)!, 6);
    expect(after.get(copyId)!).toBeGreaterThan(0);
    expect(after.get(copyId)!).toBeLessThan(before.get(copyId)!);
  });
});
