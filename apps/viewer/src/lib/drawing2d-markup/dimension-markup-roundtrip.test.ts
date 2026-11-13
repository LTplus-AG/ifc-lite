/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A dimension through the real save and restore pipeline, on a real model:
 * `dimensionSaveParams` → `@ifc-lite/create`'s `addDrawingMarkupToStore` →
 * `StepExporter` → re-parse → real WASM symbolic parse →
 * `readDrawingMarkupFromParseResult`. Same harness as
 * `overlay-parse/drawing-markup-read-real-roundtrip.test.ts`, whose doc
 * explains why only the real extractor exercises the plan-Y negation and the
 * placement chain. `building-architecture.ifc` is a millimetre model with a
 * translated storey, so the unit conversion of every stored length is covered.
 *
 * The plane matters: a restored dimension must still be told apart from the
 * cut it was not drawn on (`isDimensionOnPlane`), or it would be exported on
 * every cut after a reload.
 *
 * Needs `@ifc-lite/wasm`'s built `pkg/ifc-lite_bg.wasm`, as that test does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  EntityExtractor,
  IfcParser,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { addDrawingMarkupToStore, type MarkupAnchor } from '@ifc-lite/create';
import { isDimensionOnPlane, type Dimension2D } from '@/store/slices/drawing2DDimensions';
import type { DrawnSectionPlane } from '@/store/slices/drawing2DSlice';
import { collectFlatSymbolic, createEmptyFlatSymbolic } from '@/lib/overlay-parse/symbolic-flat';
import { buildParseResult } from '@/lib/overlay-parse/symbolic-parse';
import { readDrawingMarkupFromParseResult, type DrawingMarkupMetaLookup } from '@/lib/overlay-parse/drawing-markup-read';
import { dimensionSaveParams } from './dimension-markup-save.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = resolve(__dirname, '../../../public/samples/building-architecture.ifc');
// See drawing-markup-read-real-roundtrip.test.ts for these ids.
const STOREY_PLACEMENT_ID = 45;
const ROOT_CONTEXT_ID = 11;
const OWNER_HISTORY_ID = 1;
const LENGTH_UNIT_SCALE = 0.001;

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const near = (p: number, q: number) => Math.abs(p - q) < 1e-6;

const CUT: DrawnSectionPlane = { axis: 'front', position: 40, flipped: false };
const OTHER_CUT: DrawnSectionPlane = { axis: 'front', position: 60, flipped: false };
const CUSTOM_CUT: DrawnSectionPlane = {
  axis: 'side', position: 12, flipped: true,
  // Full-precision frame values: the plane-identity check compares the
  // in-plane axes and frame origin at 1e-6, so the JSON in `Plane` must
  // carry them through the STEP string exactly.
  custom: {
    normal: [0.6, 0.8, 0], distance: 3.25, datum: 2.2,
    pickedAt: [1.0000000001, 2.123456789012345, -1 / 3], tangent: [0.8, -0.6, 0], bitangent: [0, 0, 1],
  },
} as DrawnSectionPlane;

const DIMENSIONS: Dimension2D[] = [
  {
    id: 'd-aligned', a: { x: 1, y: 2 }, b: { x: 5, y: 7 }, offset: 0.75, orientation: 'aligned',
    text: 'Clear <>', refs: { a: { globalId: '2O2Fr$t4X7Zf8NOew3FL9r', ifcType: 'IfcWall' } }, plane: CUT,
  },
  { id: 'd-horizontal', a: { x: -2, y: 1 }, b: { x: 3, y: 4 }, offset: -1.2, orientation: 'horizontal', plane: CUSTOM_CUT },
  { id: 'd-legacy', a: { x: 0, y: 0 }, b: { x: 0, y: 2.5 }, offset: 0.4, orientation: 'vertical' },
];

async function exportAndReparse(): Promise<IfcDataStore> {
  const store = await new IfcParser().parseColumnar(toArrayBuffer(readFileSync(SAMPLE_PATH)));
  const view = new MutablePropertyView(null, 'building-architecture');
  const editor = new StoreEditor(store, view);
  const anchor: MarkupAnchor = {
    ownerHistoryId: OWNER_HISTORY_ID, storeyPlacementId: STOREY_PLACEMENT_ID, schema: 'IFC4', lengthUnitScale: LENGTH_UNIT_SCALE,
  };
  addDrawingMarkupToStore(editor, anchor, ROOT_CONTEXT_ID, {
    dimensions2D: DIMENSIONS.map((d) => dimensionSaveParams(d, { paperScale: 50, drawnPlane: CUT })),
  });
  const exported = new StepExporter(store, view).export({ schema: 'IFC4' });
  return new IfcParser().parseColumnar(toArrayBuffer(exported.content));
}

async function symbolicParse(store: IfcDataStore) {
  const processor = new GeometryProcessor();
  await processor.init();
  let flat = createEmptyFlatSymbolic();
  try {
    const collection = processor.parseSymbolicRepresentations(store.source.materialize());
    if (collection) {
      try {
        if (!collection.isEmpty) flat = collectFlatSymbolic(collection);
      } finally {
        collection.free();
      }
    }
  } finally {
    processor.dispose();
  }
  return buildParseResult(flat, {});
}

function metaFor(store: IfcDataStore): DrawingMarkupMetaLookup {
  const extractor = new EntityExtractor(store.source);
  return (expressId) => {
    const ref = store.entityIndex.byId.get(expressId);
    if (!ref) return undefined;
    const entity = extractor.extractEntity(ref);
    if (!entity || entity.type.toUpperCase() !== 'IFCANNOTATION') return undefined;
    const quantities = new Map<string, number>();
    for (const qset of extractQuantitiesOnDemand(store, expressId)) for (const q of qset.quantities) quantities.set(q.name, q.value);
    const properties = new Map<string, string>();
    for (const pset of extractPropertiesOnDemand(store, expressId)) for (const p of pset.properties) properties.set(p.name, String(p.value));
    return { objectType: entity.attributes[4] as string | null, quantities, properties };
  };
}

describe('dimension markup: real round trip on building-architecture.ifc', () => {
  it('restores every dimension with its points, offset, text, refs and cut', async () => {
    assert.ok(existsSync(SAMPLE_PATH), `missing fixture: ${SAMPLE_PATH}`);
    const store = await exportAndReparse();
    const parse = await symbolicParse(store);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    let restored: Dimension2D[];
    try {
      restored = readDrawingMarkupFromParseResult(parse, metaFor(store), { lengthUnitScale: LENGTH_UNIT_SCALE, store }).dimensions2D;
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 0, `no Distance mismatch expected: ${JSON.stringify(warnings)}`);
    assert.equal(restored.length, DIMENSIONS.length);

    for (const original of DIMENSIONS) {
      // Restored ids derive from the expressId, so match by the a point.
      const dim = restored.find((d) => near(d.a.x, original.a.x) && near(d.a.y, original.a.y));
      assert.ok(dim, `${original.id}: not restored; got ${JSON.stringify(restored.map((d) => d.a))}`);
      assert.ok(near(dim.b.x, original.b.x) && near(dim.b.y, original.b.y), `${original.id}: b ${JSON.stringify(dim.b)}`);
      assert.ok(near(dim.offset, original.offset), `${original.id}: offset ${dim.offset} vs ${original.offset}`);
      assert.equal(dim.orientation, original.orientation);
      assert.equal(dim.text, original.text);
      assert.deepEqual(dim.refs, original.refs);
      assert.deepEqual(dim.plane, original.plane);
    }

    const onCut = restored.find((d) => d.plane?.position === CUT.position);
    assert.ok(onCut);
    assert.equal(isDimensionOnPlane(onCut, CUT), true, 'still on the cut it was drawn on');
    assert.equal(isDimensionOnPlane(onCut, OTHER_CUT), false, 'still another cut\'s dimension elsewhere');
    const onCustom = restored.find((d) => d.plane?.custom);
    assert.ok(onCustom);
    assert.equal(isDimensionOnPlane(onCustom, CUSTOM_CUT), true);
    const custom = CUSTOM_CUT.custom!;
    const withCustom = (patch: Partial<typeof custom>): DrawnSectionPlane => ({ ...CUSTOM_CUT, custom: { ...custom, ...patch } });
    assert.equal(isDimensionOnPlane(onCustom, withCustom({ distance: 4 })), false);
    // The frame fields survive the trip, so the reloaded stamp still tells a
    // second pick on the same face (same normal and distance) apart ...
    assert.equal(isDimensionOnPlane(onCustom, withCustom({ pickedAt: [1.0000000001 + 0.8, 2.123456789012345 - 0.6, -1 / 3] })), false,
      'a pick moved along the face is another cut');
    assert.equal(isDimensionOnPlane(onCustom, withCustom({ tangent: [0, 0, 1], bitangent: [0.8, -0.6, 0] })), false,
      'a turned in-plane frame is another cut');
    // ... while a pick that differs only along the normal is the same frame.
    assert.equal(isDimensionOnPlane(onCustom, withCustom({ pickedAt: [1.0000000001 + 0.6, 2.123456789012345 + 0.8, -1 / 3] })), true,
      'a pick off the plane along its normal projects to the same frame origin');
  });
});
