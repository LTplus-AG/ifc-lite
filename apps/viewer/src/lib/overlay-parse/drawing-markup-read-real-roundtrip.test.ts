/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ONE test in this module that goes through the REAL pipeline
 * end-to-end, on a REAL model — everything `drawing-markup-read.test.ts`
 * deliberately does not do.
 *
 * That file's own doc comment explains its choice: it hand-builds the
 * `FlatSymbolic` a WASM parse "would have produced", mirroring only the
 * point-scaling and closed-ring duplication `rust/processing/src/
 * symbolic/*.rs` does. It never applies the plan-Y negation
 * (`rebase.rs`'s `plan()`) or composes a non-identity storey placement
 * chain — both of which only exist inside the real WASM extractor. Every
 * fixture there uses `storeyPlacementId: 54`, a bare
 * `IfcLocalPlacement(null, ...)` at the origin, so those fixtures are
 * mathematically incapable of exercising either transform: identity
 * composed with identity is still identity, round or not.
 *
 * This test instead runs the actual production pipeline against
 * `apps/viewer/public/samples/building-architecture.ifc` — a real,
 * non-identity, TRANSLATION-ONLY storey placement (site + building
 * translate the storey (+3, +3, 0) m net; see the module comment on
 * `drawing-markup-read.ts`'s `toAuthoredPoint`):
 *
 *   1. Parse the real sample file (`IfcParser.parseColumnar`).
 *   2. Write markup via #4160's REAL `addDrawingMarkupToStore` (not a
 *      re-implementation), anchored on the sample's real storey
 *      `ObjectPlacement` (#45, under building #38 under site #25).
 *   3. Export via `@ifc-lite/export`'s REAL `StepExporter`.
 *   4. Re-parse the exported bytes from scratch (a fresh `IfcDataStore`,
 *      exactly like reopening a saved file — no overlay survives this).
 *   5. Feed the re-parsed bytes through the REAL WASM
 *      `parseSymbolicRepresentations` + `collectFlatSymbolic` +
 *      `buildParseResult` — the same three calls `symbolic-parse.ts`'s
 *      `parseSymbolicAnnotations` composes, so this genuinely exercises
 *      the plan-Y negation and the placement chain the Rust extractor
 *      applies, not a stand-in for it.
 *   6. Read markup back with `readDrawingMarkupFromParseResult`, using
 *      `extractPropertiesOnDemand`/`extractQuantitiesOnDemand` (the same
 *      on-demand readers the CLI headless backend uses) as the meta
 *      lookup — no `MutablePropertyView` overlay survives step 4 either.
 *   7. Assert every point comes back equal (to float tolerance) to what
 *      was written in step 2 — the round trip issue #4153's original
 *      "save and restore agree with each other" tests never actually
 *      checked.
 *
 * Prerequisite: `@ifc-lite/wasm`'s `pkg/ifc-lite_bg.wasm` must be present
 * (`pnpm --filter @ifc-lite/wasm build`, or `node scripts/
 * fetch-prebuilt-wasm.mjs` for a prebuilt binary) — this test loads and
 * runs the real WASM module, in Node, exactly as `GeometryProcessor.init()`
 * does off the app's own worker thread.
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
const SAMPLE_PATH = resolve(__dirname, '../../../public/samples/building-architecture.ifc');

// #43 IFCBUILDINGSTOREY '00 groundfloor' → ObjectPlacement #45, chained under
// building #30 (placement #38, translation (-2.8, -2.8, +1.3) m) under site
// #23 (placement #25, translation (5.8, 5.8, -1.3) m) — net (+3, +3, 0) m,
// translation-only, exactly the chain the issue's reproduction traced.
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

function assertPointClose(actual: MarkupPoint2D, expected: MarkupPoint2D, label: string): void {
  const tolerance = 1e-6;
  assert.ok(
    Math.abs(actual.x - expected.x) < tolerance && Math.abs(actual.y - expected.y) < tolerance,
    `${label}: expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`,
  );
}

describe('drawing-markup-read: real round trip on building-architecture.ifc (#4153)', () => {
  it('recovers every markup point after write → StepExporter export → re-parse → real WASM symbolic parse', async () => {
    // Fail loudly rather than silently reporting zero tests if the committed
    // sample fixture is ever deleted or moved without updating SAMPLE_PATH.
    assert.ok(existsSync(SAMPLE_PATH), `missing fixture: ${SAMPLE_PATH}`);

    const store1: IfcDataStore = await new IfcParser().parseColumnar(
      toArrayBuffer(readFileSync(SAMPLE_PATH)),
    );

    const view = new MutablePropertyView(null, 'building-architecture');
    const editor = new StoreEditor(store1, view);

    const anchor: MarkupAnchor = {
      ownerHistoryId: OWNER_HISTORY_ID,
      storeyPlacementId: STOREY_PLACEMENT_ID,
      schema: 'IFC4',
      lengthUnitScale: LENGTH_UNIT_SCALE,
    };

    // Exactly the four fixtures from the issue's own reproduction table.
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

    // 3. Export the overlay into a real STEP file.
    const exportResult = new StepExporter(store1, view).export({ schema: 'IFC4' });

    // 4. Re-parse from scratch — the same thing reopening a saved file does.
    // No overlay/MutablePropertyView survives this: everything downstream
    // reads only what actually landed in the exported bytes.
    const store2: IfcDataStore = await new IfcParser().parseColumnar(
      toArrayBuffer(exportResult.content),
    );
    const sourceBytes = store2.source.materialize();

    // 5. Real WASM symbolic parse — the same three calls
    // `parseSymbolicAnnotations` composes.
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

    // 6. Meta lookup straight off the re-parsed store's source bytes — the
    // same on-demand extractors `packages/cli/src/headless-backend.ts` uses,
    // not the overlay `MutablePropertyView` (which has nothing to say about
    // a file that was just re-parsed from disk).
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

    // Sanity: the real placement chain actually distorted the parsed
    // geometry (else this test could pass vacuously the way the synthetic
    // fixtures did). The bug's own reproduction: local (1,2) parses back as
    // world (4,-5) before any compensation is applied — assert that raw
    // value directly, not merely that the final (compensated) result is
    // correct, so a regression that collapses the placement chain to
    // identity (making compensation a no-op) cannot pass vacuously.
    const rawLines = [...parseResult.loose, ...[...parseResult.byStorey.values()].flatMap((b) => b.lines)];
    assert.ok(rawLines.length > 0, 'expected parsed annotation geometry');
    const rawMeasureLine = rawLines.find(
      (l) => Math.abs(l.line.start.x - 4) < 1e-6 && Math.abs(l.line.start.y - (-5)) < 1e-6,
    );
    assert.ok(
      rawMeasureLine,
      `expected raw measure start (4, -5) before compensation; got ${JSON.stringify(rawLines.map((l) => l.line.start))}`,
    );

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
});
