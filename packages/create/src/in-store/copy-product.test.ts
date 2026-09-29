/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Copying a product (#6232 C3, decision D7), on the committed `hello-wall`
 * sample: a wall with two windows in two openings, each opening placed
 * relative to the wall and each window relative to its opening.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { copyProductInStore, createCopyContext, productStoreyOrigin } from './copy-product.js';
import { resolveDuplicateSource } from './resolve-source.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addColumnToStore } from './column.js';
import { asRef } from './style-entity-reader.js';

const SAMPLE = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const WALL = 1222;
const WALL_PLACEMENT = 1235;
const WALL_SHAPE = 1230;
const STOREY = 42;

let store: IfcDataStore;
let view: MutablePropertyView;
let editor: StoreEditor;

async function parse(bytes: Uint8Array): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}

const created = (type: string) => editor.getNewEntities().filter((e) => e.type.toUpperCase() === type.toUpperCase());
const attr = (id: number, index: number) => editor.getNewEntity(id)?.attributes[index];
const ref = (id: number, index: number) => asRef(attr(id, index));
/** The IfcCartesianPoint a created product's placement puts it at, and the placement's parent. */
function placementOf(id: number): { parent: number | null; location: number[]; refDirection: number[] | null } {
  const placement = ref(id, 5)!;
  const axis = ref(placement, 1)!;
  const direction = ref(axis, 2);
  return {
    parent: ref(placement, 0),
    location: attr(ref(axis, 0)!, 0) as number[],
    refDirection: direction === null ? null : (attr(direction, 0) as number[]),
  };
}

beforeEach(async () => {
  store = await parse(readFileSync(SAMPLE));
  view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  editor = new StoreEditor(store, view);
});

describe('copyProductInStore (#6232 C3)', () => {
  it('copies a wall with its windows: new openings, new voids and fills between the copies', () => {
    const result = copyProductInStore(createCopyContext(store, editor), WALL, { offset: [0, 3, 0] });

    expect(result.openingIds).toHaveLength(2);
    expect(result.fillingIds).toHaveLength(2);
    expect(created('IfcWall').map((e) => e.expressId)).toEqual([result.copyId]);
    expect(created('IfcWindow').map((e) => e.expressId).sort()).toEqual([...result.fillingIds].sort());

    const voids = created('IfcRelVoidsElement');
    expect(voids.map((r) => [asRef(r.attributes[4]), asRef(r.attributes[5])]))
      .toEqual(result.openingIds.map((opening) => [result.copyId, opening]));
    const fills = created('IfcRelFillsElement');
    expect(fills.map((r) => [asRef(r.attributes[4]), asRef(r.attributes[5])]))
      .toEqual(result.openingIds.map((opening, i) => [opening, result.fillingIds[i]]));

    // Each opening keeps its place in the wall, under the copy's placement;
    // each window under its opening's copy.
    const wallPlacement = ref(result.copyId, 5);
    for (const [i, opening] of result.openingIds.entries()) {
      expect(placementOf(opening).parent).toBe(wallPlacement);
      expect(placementOf(result.fillingIds[i]).parent).toBe(ref(opening, 5));
    }
    // The wall itself moved 3 m (the sample is in metres) under the same storey placement.
    const source = resolveDuplicateSource(store, WALL, editor);
    expect(placementOf(result.copyId).parent).toBe(source.parentPlacementId);
    expect(placementOf(result.copyId).location).toEqual([source.sourceLocation[0], source.sourceLocation[1] + 3, source.sourceLocation[2]]);
    // Contained in the storey; the openings are not (IFC: they are voids, not elements of the storey).
    const contained = created('IfcRelContainedInSpatialStructure').map((r) => asRef((r.attributes[4] as unknown[])[0]));
    expect(contained.sort()).toEqual([result.copyId, ...result.fillingIds].sort());
  });

  it('gives every copied record a fresh GlobalId (D7)', () => {
    const ctx = createCopyContext(store, editor);
    copyProductInStore(ctx, WALL, { offset: [0, 3, 0] });
    copyProductInStore(ctx, WALL, { offset: [0, 6, 0] });
    const fresh = editor.getNewEntities().filter((e) => /^IFC(WALL|WINDOW|OPENINGELEMENT|REL)/i.test(e.type)).map((e) => e.attributes[0] as string);
    expect(fresh.length).toBeGreaterThan(10);
    expect(new Set(fresh).size).toBe(fresh.length);
    const text = readFileSync(SAMPLE, 'utf8');
    for (const guid of fresh) expect(text.includes(`'${guid}'`), guid).toBe(false);
  });

  it('turns a copy about a pivot: its location and its RefDirection', () => {
    const source = resolveDuplicateSource(store, WALL, editor);
    const [x, y] = source.sourceLocation;
    const result = copyProductInStore(createCopyContext(store, editor), WALL, { turn: Math.PI / 2, pivot: [x + 1, y] });
    const placed = placementOf(result.copyId);
    expect(placed.location[0]).toBeCloseTo(x + 1);
    expect(placed.location[1]).toBeCloseTo(y - 1);
    // The sample's wall runs along +X: a quarter turn runs it along +Y.
    expect(placed.refDirection![0]).toBeCloseTo(0);
    expect(placed.refDirection![1]).toBeCloseTo(1);
    // The openings turn with the wall because they are placed in it: their own placements are unchanged.
    for (const opening of result.openingIds) expect(placementOf(opening).parent).toBe(ref(result.copyId, 5));
  });

  it('shares a shape read from the file, and copies one created this session record by record', () => {
    const ctx0 = createCopyContext(store, editor);
    const fromFile = copyProductInStore(ctx0, WALL, { offset: [0, 3, 0] });
    expect(ref(fromFile.copyId, 6)).toBe(WALL_SHAPE);

    const column = addColumnToStore(editor, resolveSpatialAnchor(store, STOREY, view), { Position: [1, 1, 0], Width: 0.3, Depth: 0.3, Height: 3 });
    const shape = ref(column.columnId, 6)!;
    const before = editor.getNewEntities().length;
    const copy = copyProductInStore(createCopyContext(store, editor), column.columnId, { offset: [2, 0, 0] });
    const copiedShape = ref(copy.copyId, 6)!;
    expect(copiedShape).not.toBe(shape);
    expect(editor.getNewEntity(copiedShape)?.type).toBe(editor.getNewEntity(shape)?.type);
    // The copy's own shape records, not a pointer back into the column's.
    const reps = attr(copiedShape, 2) as string[];
    expect(reps.map((r) => asRef(r))).not.toEqual((attr(shape, 2) as string[]).map((r) => asRef(r)));
    expect(editor.getNewEntities().length).toBeGreaterThan(before + 6);
  });

  it('puts a copy on another storey at the same plan position, under that storey', () => {
    // A second storey 3 m up, placed relative to what the first one is (#59).
    const point = editor.addEntity('IfcCartesianPoint', [[0, 0, 3]]);
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point.expressId}`, null, null]);
    const upper = editor.addEntity('IfcLocalPlacement', ['#59', `#${axis.expressId}`]);
    const storey = editor.addEntity('IfcBuildingStorey', ['0$abcdefghijklmnopqrstu', null, 'Upper', null, null, `#${upper.expressId}`, null, null, '.ELEMENT.', 3]);

    const result = copyProductInStore(createCopyContext(store, editor), WALL, { targetStoreyId: storey.expressId });
    expect(placementOf(result.copyId).parent).toBe(upper.expressId);
    const source = resolveDuplicateSource(store, WALL, editor);
    expect(placementOf(result.copyId).location).toEqual(source.sourceLocation);
    expect(result.storeyId).toBe(storey.expressId);
    const containers = created('IfcRelContainedInSpatialStructure').map((r) => asRef(r.attributes[5]));
    expect(new Set(containers)).toEqual(new Set([storey.expressId]));
    expect(result.fillingIds).toHaveLength(2);
  });

  it('refuses a window or an opening on its own: they are copied with their wall', () => {
    const ctx = createCopyContext(store, editor);
    expect(() => copyProductInStore(ctx, 1262)).toThrow(/copy the wall/);
    expect(() => copyProductInStore(ctx, 1299)).toThrow(/opening/);
    expect(editor.getNewEntities()).toHaveLength(0);
  });

  it('reads the storey-local origin a paste lines up with', () => {
    const origin = productStoreyOrigin(createCopyContext(store, editor), WALL);
    const source = resolveDuplicateSource(store, WALL, editor);
    expect(origin?.storeyId).toBe(STOREY);
    expect(origin?.origin).toEqual(source.sourceLocation);
    expect(source.placementExpressId).toBe(WALL_PLACEMENT);
  });

  it('exports copies whose references resolve: the shape, the voids and the fills', async () => {
    const ctx = createCopyContext(store, editor);
    const result = copyProductInStore(ctx, WALL, { offset: [0, 3, 0] });
    const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
    const reparsed = await parse(new TextEncoder().encode(text));
    const ids = (type: string) => reparsed.entityIndex.byType.get(type) ?? [];
    expect(ids('IFCWALL')).toHaveLength(2);
    expect(ids('IFCRELVOIDSELEMENT')).toHaveLength(4);
    expect(ids('IFCRELFILLSELEMENT')).toHaveLength(4);
    // The copy names the shared shape as a reference (#1230), not the integer 1230.
    expect(text).toMatch(new RegExp(`#${result.copyId}=IFCWALL\\('[^']{22}',\\$,'Wall',\\$,\\$,#\\d+,#${WALL_SHAPE},`));
  });
});

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));

/** Each element's meshed volume, through the real wasm pipeline. */
async function meshedVolumes(text: string): Promise<Map<number, number>> {
  const { IfcAPI, initSync } = await import('@ifc-lite/wasm');
  initSync({ module: readFileSync(WASM_PATH) });
  const api = new IfcAPI();
  const bytes = new TextEncoder().encode(text);
  api.setComputeGeometryHashes(1e-3);
  const pre = api.buildPrePassOnce(bytes);
  try {
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      const volumes = new Map<number, number>();
      const ids = collection.geometryHashIds;
      const values = collection.geometryVolumeValues;
      for (let i = 0; i < ids.length; i++) volumes.set(ids[i], values[i]);
      return volumes;
    } finally {
      collection.free();
    }
  } finally {
    api.clearPrePassCache();
  }
}

describe.skipIf(!existsSync(WASM_PATH))('a copied wall meshes with its windows cut (#6232 C3)', () => {
  it('the copy loses the same volume to its openings as the original', async () => {
    const result = copyProductInStore(createCopyContext(store, editor), WALL, { offset: [0, 3, 0] });
    const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
    const volumes = await meshedVolumes(text);
    const original = volumes.get(WALL)!;
    expect(original).toBeGreaterThan(0);
    expect(volumes.get(result.copyId)).toBeCloseTo(original, 6);
    // Without its voids the wall body is bigger: the copy really is cut.
    const uncut = await meshedVolumes(text.replace(/^#\d+=IFCRELVOIDSELEMENT\(.*\);$/gm, ''));
    expect(uncut.get(result.copyId)!).toBeGreaterThan(original + 1e-3);
  });
});
