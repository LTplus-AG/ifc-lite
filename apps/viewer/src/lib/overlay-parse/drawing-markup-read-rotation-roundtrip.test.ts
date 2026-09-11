/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same real end-to-end pipeline as `drawing-markup-read-real-roundtrip.
 * test.ts`, but anchored on a storey whose placement chain composes a
 * genuine, non-degenerate ROTATION — the half of `toAuthoredPoint`'s
 * claimed coverage ("in-plane rotation about Z, and non-degenerate tilt")
 * that `building-architecture.ifc`'s translation-only storey chain cannot
 * exercise. Without this test, a mutation that dropped the rotation
 * composition out of `toAuthoredPoint` entirely (keeping only translation
 * and the plan-Y negation) passed every other test in this module.
 *
 * Fixture: `apps/viewer/public/samples/infra-bridge.ifc`, an existing repo
 * sample — not authored for this test. Its storey #43 ("road rail bridge -
 * approach") placement #45 chains:
 *
 *   #45 IFCLOCALPLACEMENT(#38, #46)      — storey's own axis
 *   #38 IFCLOCALPLACEMENT(#31, #39)      — RefDirection ≈ (0, -1, 0):  90°
 *   #31 IFCLOCALPLACEMENT(#22, #32)      — RefDirection ≈ (-0.5, 0.866, 0): 120°
 *   #22 IFCLOCALPLACEMENT($,   #7)       — root, identity
 *
 * i.e. three composed non-identity rotations (plus the storey's own
 * IFCAXIS2PLACEMENT3D #46), verified by reading the entities directly
 * (`grep`/manual trace), not assumed. The file's length unit
 * (`#15=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)`) is also millimetre —
 * the same non-metre unit `building-architecture.ifc` uses — so this one
 * fixture covers BOTH the rotation half and the non-metre-unit half of
 * `toAuthoredPoint`'s claimed coverage together.
 *
 * See `drawing-markup-read-real-roundtrip.test.ts`'s doc comment for why
 * this must run the real pipeline (parse → real `addDrawingMarkupToStore`
 * → real `StepExporter` → fresh re-parse with no overlay → real WASM
 * symbolic parse → `readDrawingMarkupFromParseResult`) rather than a
 * hand-built `FlatSymbolic` that mirrors the writer's own math — a
 * synthetic fixture agrees with itself, not with the format, which is
 * exactly what hid the original #4153 bug.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
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
import {
  addDrawingMarkupToStore,
  type MarkupAnchor,
  type MarkupPoint2D,
} from '@ifc-lite/create';

import { collectFlatSymbolic, createEmptyFlatSymbolic } from './symbolic-flat.js';
import { buildParseResult } from './symbolic-parse.js';
import { readDrawingMarkupFromParseResult, type DrawingMarkupMetaLookup } from './drawing-markup-read.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = resolve(__dirname, '../../../public/samples/infra-bridge.ifc');

// #43 IFCBUILDINGSTOREY 'road rail bridge - approach' → ObjectPlacement #45,
// chained #45 -> #38 -> #31 -> #22 (root, identity). #38's and #31's
// IFCAXIS2PLACEMENT3D RefDirections are (≈0,-1,0) and (≈-0.5,0.866,0) —
// 90° and 120° rotations about Z, composed on top of #46's own axis at
// #45 — a genuinely non-identity, non-degenerate rotation, verified by
// reading the entities (see module comment above).
const STOREY_PLACEMENT_ID = 45;
// #11 IFCGEOMETRICREPRESENTATIONCONTEXT, the sample's root Model context —
// IFCPROJECT #13's sole RepresentationContexts entry.
const ROOT_CONTEXT_ID = 11;
// #1 IFCOWNERHISTORY.
const OWNER_HISTORY_ID = 1;
const LENGTH_UNIT_SCALE = 0.001; // IFCSIUNIT #15: .MILLI..METRE.

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// Looser than the translation-only real-roundtrip test's 1e-6: the
// symbolic Rust extractor's `rebase.rs::plan()` works in `f32`
// (`x: f32, y: f32` — see that module's doc comment), and composing three
// non-identity rotation matrices before inverting the top-left 2x2 (see
// `toAuthoredPoint`) accumulates single-precision rounding that a pure
// translation never exercises. Measured error on this fixture is ~3e-6 on
// coordinates of magnitude 1-5; 1e-4 leaves margin while still failing hard
// (by orders of magnitude) on a genuinely broken transform.
function assertPointClose(actual: MarkupPoint2D, expected: MarkupPoint2D, label: string): void {
  const tolerance = 1e-4;
  assert.ok(
    Math.abs(actual.x - expected.x) < tolerance && Math.abs(actual.y - expected.y) < tolerance,
    `${label}: expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`,
  );
}

describe(
  'drawing-markup-read: real round trip on infra-bridge.ifc (rotated storey chain, #4153)',
  { skip: !existsSync(SAMPLE_PATH) },
  () => {
    it('recovers every markup point through a composed-rotation storey placement chain', async () => {
      const store1: IfcDataStore = await new IfcParser().parseColumnar(
        toArrayBuffer(readFileSync(SAMPLE_PATH)),
      );

      const view = new MutablePropertyView(null, 'infra-bridge');
      const editor = new StoreEditor(store1, view);

      const anchor: MarkupAnchor = {
        ownerHistoryId: OWNER_HISTORY_ID,
        storeyPlacementId: STOREY_PLACEMENT_ID,
        schema: 'IFC4',
        lengthUnitScale: LENGTH_UNIT_SCALE,
      };

      const originalMeasure = { start: { x: 1, y: 2 }, end: { x: 5, y: 7 } };
      const originalPolygon = {
        points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
      };
      const originalText = { position: { x: 2, y: 2 } };
      const originalCloud = { points: [{ x: -1, y: -1 }, { x: 3, y: 2 }] as const };

      addDrawingMarkupToStore(editor, anchor, ROOT_CONTEXT_ID, {
        measure2DResults: [{
          id: 'm1',
          start: originalMeasure.start,
          end: originalMeasure.end,
          distance: Math.hypot(
            originalMeasure.end.x - originalMeasure.start.x,
            originalMeasure.end.y - originalMeasure.start.y,
          ),
        }],
        polygonArea2DResults: [{ id: 'p1', points: originalPolygon.points, area: 12, perimeter: 14 }],
        textAnnotations2D: [{ id: 't1', position: originalText.position, text: 'hello' }],
        cloudAnnotations2D: [{ id: 'c1', points: originalCloud.points, label: 'note' }],
      });

      const exportResult = new StepExporter(store1, view).export({ schema: 'IFC4' });

      const store2: IfcDataStore = await new IfcParser().parseColumnar(
        toArrayBuffer(exportResult.content),
      );
      const sourceBytes = store2.source.materialize();

      const processor = new GeometryProcessor();
      await processor.init();
      let flat = createEmptyFlatSymbolic();
      try {
        const collection = processor.parseSymbolicRepresentations(sourceBytes);
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
      const parseResult = buildParseResult(flat, {});

      const extractor = new EntityExtractor(store2.source);
      const meta: DrawingMarkupMetaLookup = (expressId) => {
        const ref = store2.entityIndex.byId.get(expressId);
        if (!ref) return undefined;
        const entity = extractor.extractEntity(ref);
        if (!entity || entity.type.toUpperCase() !== 'IFCANNOTATION') return undefined;
        const quantities = new Map<string, number>();
        for (const qset of extractQuantitiesOnDemand(store2, expressId)) {
          for (const q of qset.quantities) quantities.set(q.name, q.value);
        }
        const properties = new Map<string, string>();
        for (const pset of extractPropertiesOnDemand(store2, expressId)) {
          for (const p of pset.properties) properties.set(p.name, String(p.value));
        }
        return { objectType: entity.attributes[4] as string | null, quantities, properties };
      };

      const result = readDrawingMarkupFromParseResult(parseResult, meta, {
        lengthUnitScale: LENGTH_UNIT_SCALE,
        store: store2,
      });

      assert.strictEqual(result.measure2DResults.length, 1, 'expected exactly one measure result');
      assert.strictEqual(result.polygonArea2DResults.length, 1, 'expected exactly one polygon result');
      assert.strictEqual(result.textAnnotations2D.length, 1, 'expected exactly one text result');
      assert.strictEqual(result.cloudAnnotations2D.length, 1, 'expected exactly one cloud result');

      const measure = result.measure2DResults[0];
      assertPointClose(measure.start, originalMeasure.start, 'measure.start');
      assertPointClose(measure.end, originalMeasure.end, 'measure.end');

      const polygon = result.polygonArea2DResults[0];
      assert.strictEqual(polygon.points.length, originalPolygon.points.length);
      for (let i = 0; i < originalPolygon.points.length; i++) {
        assertPointClose(polygon.points[i], originalPolygon.points[i], `polygon.points[${i}]`);
      }

      const text = result.textAnnotations2D[0];
      assertPointClose(text.position, originalText.position, 'text.position');

      const cloud = result.cloudAnnotations2D[0];
      assertPointClose(cloud.points[0], originalCloud.points[0], 'cloud.points[0]');
      assertPointClose(cloud.points[1], originalCloud.points[1], 'cloud.points[1]');
    });
  },
);
