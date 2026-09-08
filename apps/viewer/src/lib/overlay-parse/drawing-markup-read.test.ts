/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read-side coverage for issue #4153's "save 2D drawing markup into the IFC
 * model" — the reader that recognises PR #4160's `DRAWING_MARKUP_OBJECTTYPE`
 * tag and rehydrates typed `Drawing2DState` markup from the symbolic-overlay
 * parse.
 *
 * Round-trip tests write via #4160's actual `addXMarkupToStore` builders
 * (real production code, not a re-implementation), then hand-build the
 * `FlatSymbolic` a WASM parse would have produced for those exact entities
 * — mirroring `rust/processing/src/symbolic/*.rs`'s point-scaling and
 * closed-ring duplication (see comments below) — and feed that into the
 * REAL `buildParseResult` (`symbolic-parse.ts`), the same function
 * production uses. Only the WASM boundary itself is stood in for; every
 * step after it is genuine production code. `hand-written-fixture` below
 * skips the writer entirely and hand-authors the store/quantity/geometry
 * data, so at least one case is checked against a fixture this suite did
 * not itself produce.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
  type NewEntity,
} from '@ifc-lite/mutations';
import {
  addCloudMarkupToStore,
  addMeasureMarkupToStore,
  addPolygonAreaMarkupToStore,
  addTextMarkupToStore,
  DRAWING_MARKUP_OBJECTTYPE,
  DRAWING_MARKUP_PSET_NAME,
  DRAWING_MARKUP_QSET_NAME,
  type MarkupAnchor,
} from '@ifc-lite/create';

import { buildParseResult } from './symbolic-parse.js';
import { createEmptyFlatSymbolic, type FlatSymbolic } from './symbolic-flat.js';
import {
  readDrawingMarkupAnnotation,
  readDrawingMarkupFromParseResult,
  type DrawingMarkupAnnotationSource,
  type DrawingMarkupMetaLookup,
} from './drawing-markup-read.js';

/** Spy on `console.warn`, matching the convention `profile-entries.test.ts`
 *  (this directory) already uses for the same "did it actually warn?"
 *  question. Always restores, even if `run` throws. */
function withWarnSpy<T>(run: (calls: unknown[][]) => T): T {
  const calls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => calls.push(args);
  try {
    return run(calls);
  } finally {
    console.warn = originalWarn;
  }
}

// ── Shared write-side fixture harness (mirrors drawing-markup.test.ts) ────

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

const ROOT_CONTEXT_ID = 14;

function newEditor(maxId = 200) {
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(makeStore(maxId), view);
  const contextId = editor.addEntity('IfcGeometricRepresentationSubContext', [
    'Annotation', 'Model', '*', '*', '*', '*', `#${ROOT_CONTEXT_ID}`, null, '.PLAN_VIEW.', null,
  ]).expressId;
  return { view, editor, contextId };
}

function entitiesById(view: MutablePropertyView): Map<number, NewEntity> {
  return new Map(view.getNewEntities().map((e) => [e.expressId, e]));
}

/** Follow an `#N` STEP reference into the fixture store's new entities. */
function deref(entities: Map<number, NewEntity>, ref: unknown): NewEntity {
  const id = Number(String(ref).slice(1));
  const entity = entities.get(id);
  assert.ok(entity, `expected new entity #${id}`);
  return entity;
}

/** Read an IfcPolyline's points straight off the fixture store. */
function polylinePoints(entities: Map<number, NewEntity>, polylineId: number): [number, number][] {
  const refs = deref(entities, `#${polylineId}`).attributes[0] as string[];
  return refs.map((r) => deref(entities, r).attributes[0] as [number, number]);
}

/** Build the `objectType`/`quantities`/`properties` meta a real reader
 *  would source from a `PropertyTable` + entity attribute read, straight
 *  off the fixture's `MutablePropertyView`. */
function metaLookupFromView(view: MutablePropertyView, entities: Map<number, NewEntity>): DrawingMarkupMetaLookup {
  return (expressId) => {
    const entity = entities.get(expressId);
    if (!entity || entity.type !== 'IfcAnnotation') return undefined;
    const quantities = new Map<string, number>();
    for (const qset of view.getQuantitiesForEntity(expressId)) {
      if (qset.name !== DRAWING_MARKUP_QSET_NAME) continue;
      for (const q of qset.quantities) quantities.set(q.name, q.value);
    }
    const properties = new Map<string, string>();
    for (const pset of view.getForEntity(expressId)) {
      if (pset.name !== DRAWING_MARKUP_PSET_NAME) continue;
      for (const p of pset.properties) properties.set(p.name, String(p.value));
    }
    return {
      objectType: entity.attributes[4] as string | null, // IfcAnnotation attribute order, see drawing-markup.ts
      quantities,
      properties,
    };
  };
}

// ── FlatSymbolic construction — the stand-in WASM boundary ────────────────
//
// Mirrors `rust/processing/src/symbolic/{items,fill}.rs`: every coordinate
// is multiplied by the model's unit scale, and a closed IfcPolyline's
// points (including the writer's explicit closing duplicate) are carried
// through verbatim — nothing here dedupes or re-tessellates.

interface FlatBuilder {
  flat: FlatSymbolic;
  addPolyline(points: [number, number][], ownerId: number, unitScale: number): void;
  addFillRing(points: [number, number][], ownerId: number, unitScale: number): void;
  addText(x: number, y: number, content: string, ownerId: number, unitScale: number, sizeInY: number): void;
}

function newFlatBuilder(): FlatBuilder {
  const flat = createEmptyFlatSymbolic();
  flat.typeNames = ['IfcAnnotation'];
  const polyPoints: number[] = [];
  const polyStart: number[] = [0];
  const polyOwner: number[] = [];
  const polyWorldY: number[] = [];
  const polyFlags: number[] = [];
  const polyType: number[] = [];
  const fillPoints: number[] = [];
  const fillPointStart: number[] = [0];
  const fillHoleStart: number[] = [0];
  const fillOwner: number[] = [];
  const fillWorldY: number[] = [];
  const fillFlags: number[] = [];
  const fillType: number[] = [];
  const textContent: string[] = [];
  const textAlignment: string[] = [];
  const textXs: number[] = [];
  const textYs: number[] = [];
  const textDirX: number[] = [];
  const textDirY: number[] = [];
  const textHeight: number[] = [];
  const textTargetPx: number[] = [];
  const textOwner: number[] = [];
  const textWorldY: number[] = [];
  const textType: number[] = [];

  return {
    flat,
    addPolyline(points, ownerId, unitScale) {
      const scaled = points.map(([x, y]): [number, number] => [x * unitScale, y * unitScale]);
      const n = scaled.length;
      const closed = n >= 2
        && Math.abs(scaled[0][0] - scaled[n - 1][0]) < 0.001
        && Math.abs(scaled[0][1] - scaled[n - 1][1]) < 0.001;
      for (const [x, y] of scaled) polyPoints.push(x, y);
      polyStart.push(polyPoints.length / 2);
      polyOwner.push(ownerId);
      polyWorldY.push(0);
      polyFlags.push(closed ? 1 : 0);
      polyType.push(0);
      flat.polyPoints = Float32Array.from(polyPoints);
      flat.polyStart = Uint32Array.from(polyStart);
      flat.polyOwner = Uint32Array.from(polyOwner);
      flat.polyWorldY = Float32Array.from(polyWorldY);
      flat.polyFlags = Uint8Array.from(polyFlags);
      flat.polyType = Uint16Array.from(polyType);
    },
    addFillRing(points, ownerId, unitScale) {
      for (const [x, y] of points) fillPoints.push(x * unitScale, y * unitScale);
      fillPointStart.push(fillPoints.length);
      fillHoleStart.push(fillHoleStart[fillHoleStart.length - 1]);
      fillOwner.push(ownerId);
      fillWorldY.push(0);
      fillFlags.push(0);
      fillType.push(0);
      flat.fillPoints = Float32Array.from(fillPoints);
      flat.fillPointStart = Uint32Array.from(fillPointStart);
      flat.fillHoles = new Uint32Array(0);
      flat.fillHoleStart = Uint32Array.from(fillHoleStart);
      flat.fillColor = Float32Array.from(fillOwner.flatMap(() => [0, 0, 0, 1]));
      flat.fillHatch = Float32Array.from(fillOwner.flatMap(() => [0, 0, NaN, 0]));
      flat.fillOwner = Uint32Array.from(fillOwner);
      flat.fillWorldY = Float32Array.from(fillWorldY);
      flat.fillFlags = Uint8Array.from(fillFlags);
      flat.fillType = Uint16Array.from(fillType);
    },
    addText(x, y, content, ownerId, unitScale, sizeInY) {
      textContent.push(content);
      textAlignment.push('top-left');
      textXs.push(x * unitScale);
      textYs.push(y * unitScale);
      textDirX.push(1);
      textDirY.push(0);
      // Rust extractor recovers a single-line cap height as SizeInY × 0.7;
      // buildParseResult further divides by the split line count.
      textHeight.push(sizeInY * unitScale * 0.7);
      textTargetPx.push(0);
      textOwner.push(ownerId);
      textWorldY.push(0);
      textType.push(0);
      flat.textContent = textContent;
      flat.textAlignment = textAlignment;
      flat.textX = Float32Array.from(textXs);
      flat.textY = Float32Array.from(textYs);
      flat.textDirX = Float32Array.from(textDirX);
      flat.textDirY = Float32Array.from(textDirY);
      flat.textHeight = Float32Array.from(textHeight);
      flat.textTargetPx = Float32Array.from(textTargetPx);
      flat.textColor = Float32Array.from(textOwner.flatMap(() => [0, 0, 0, 0]));
      flat.textOwner = Uint32Array.from(textOwner);
      flat.textWorldY = Float32Array.from(textWorldY);
      flat.textType = Uint16Array.from(textType);
    },
  };
}

// ── Round trip: measure ────────────────────────────────────────────────

describe('drawing-markup-read: measure round trip', () => {
  it('reconstructs a Measure2DResult written by addMeasureMarkupToStore (metre model)', () => {
    const { view, editor, contextId } = newEditor();
    const anchor: MarkupAnchor = { ownerHistoryId: 5, storeyPlacementId: 54 };
    const written = addMeasureMarkupToStore(editor, anchor, contextId, {
      start: { x: 1, y: 2 },
      end: { x: 5, y: 7 },
      distance: 6.4031242374328485,
    });

    const entities = entitiesById(view);
    const points = polylinePoints(entities, written.polylineId);
    const builder = newFlatBuilder();
    builder.addPolyline(points, written.annotationId, 1);
    const parseResult = buildParseResult(builder.flat, {});

    const meta = metaLookupFromView(view, entities);
    const result = readDrawingMarkupFromParseResult(parseResult, meta, { lengthUnitScale: 1 });

    assert.strictEqual(result.measure2DResults.length, 1);
    const m = result.measure2DResults[0];
    assert.deepStrictEqual(m.start, { x: 1, y: 2 });
    assert.deepStrictEqual(m.end, { x: 5, y: 7 });
    assert.ok(Math.abs(m.distance - 6.4031242374328485) < 1e-6, `distance was ${m.distance}`);
  });

  it('inverts the writer\'s unit scale for a millimetre model', () => {
    const { view, editor, contextId } = newEditor();
    // 1 native unit = 0.001 m (millimetre model).
    const anchor: MarkupAnchor = { ownerHistoryId: null, storeyPlacementId: 54, lengthUnitScale: 0.001 };
    const written = addMeasureMarkupToStore(editor, anchor, contextId, {
      start: { x: 0, y: 0 },
      end: { x: 3, y: 4 },
      distance: 5,
    });

    const entities = entitiesById(view);
    // Points were stored in the NATIVE unit (mm): confirm the writer really
    // scaled before asserting the reader inverts it.
    const storedPoints = polylinePoints(entities, written.polylineId);
    assert.deepStrictEqual(storedPoints, [[0, 0], [3000, 4000]]);

    const builder = newFlatBuilder();
    // The WASM extractor multiplies by unit_scale (0.001) as it tessellates,
    // landing points back in metres — the same thing this test's
    // `addPolyline` does with `unitScale`.
    builder.addPolyline(storedPoints, written.annotationId, 0.001);
    const parseResult = buildParseResult(builder.flat, {});

    const meta = metaLookupFromView(view, entities);
    const result = readDrawingMarkupFromParseResult(parseResult, meta, { lengthUnitScale: 0.001 });

    assert.strictEqual(result.measure2DResults.length, 1);
    const m = result.measure2DResults[0];
    assert.deepStrictEqual(m.start, { x: 0, y: 0 });
    assert.deepStrictEqual(m.end, { x: 3, y: 4 });
    assert.ok(Math.abs(m.distance - 5) < 1e-6, `distance was ${m.distance}`);
  });
});

// ── Round trip: polygon area ───────────────────────────────────────────

describe('drawing-markup-read: polygon area round trip', () => {
  it('reconstructs a PolygonArea2DResult, undoing the writer\'s auto-close duplicate', () => {
    const { view, editor, contextId } = newEditor();
    const anchor: MarkupAnchor = { ownerHistoryId: 5, storeyPlacementId: 54 };
    const points = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
    const written = addPolygonAreaMarkupToStore(editor, anchor, contextId, {
      points,
      area: 12,
      perimeter: 14,
    });

    const entities = entitiesById(view);
    const storedPoints = polylinePoints(entities, written.polylineId);
    assert.strictEqual(storedPoints.length, 5, 'writer auto-closes: 4 vertices + 1 duplicate');

    const builder = newFlatBuilder();
    builder.addPolyline(storedPoints, written.annotationId, 1);
    const parseResult = buildParseResult(builder.flat, {});

    const meta = metaLookupFromView(view, entities);
    const result = readDrawingMarkupFromParseResult(parseResult, meta, {});

    assert.strictEqual(result.polygonArea2DResults.length, 1);
    const p = result.polygonArea2DResults[0];
    assert.deepStrictEqual(p.points, points);
    assert.strictEqual(p.area, 12);
    assert.strictEqual(p.perimeter, 14);
  });

  it('inverts the writer\'s unit scale for a millimetre model, leaving Area unscaled', () => {
    const { view, editor, contextId } = newEditor();
    // 1 native unit = 0.001 m (millimetre model).
    const anchor: MarkupAnchor = { ownerHistoryId: null, storeyPlacementId: 54, lengthUnitScale: 0.001 };
    const points = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
    const written = addPolygonAreaMarkupToStore(editor, anchor, contextId, {
      points,
      area: 12, // raw SI m^2 — the writer never scales Area (see drawing-markup.ts)
      perimeter: 14, // metres — the writer scales this through toNativeLength
    });

    const entities = entitiesById(view);
    // Points and Perimeter were stored in the NATIVE unit (mm): confirm the
    // writer really scaled before asserting the reader inverts it.
    const storedPoints = polylinePoints(entities, written.polylineId);
    assert.deepStrictEqual(storedPoints, [[0, 0], [4000, 0], [4000, 3000], [0, 3000], [0, 0]]);

    const builder = newFlatBuilder();
    builder.addPolyline(storedPoints, written.annotationId, 0.001);
    const parseResult = buildParseResult(builder.flat, {});

    const meta = metaLookupFromView(view, entities);
    const result = readDrawingMarkupFromParseResult(parseResult, meta, { lengthUnitScale: 0.001 });

    assert.strictEqual(result.polygonArea2DResults.length, 1);
    const p = result.polygonArea2DResults[0];
    assert.deepStrictEqual(p.points, points);
    assert.strictEqual(p.area, 12, 'Area must stay raw SI m^2, unlike Perimeter it is never native-unit-scaled');
    assert.ok(Math.abs(p.perimeter - 14) < 1e-6, `perimeter was ${p.perimeter}`);
  });
});

// ── Round trip: text ────────────────────────────────────────────────────

describe('drawing-markup-read: text round trip', () => {
  it('reconstructs a single-line TextAnnotation2D', () => {
    const { view, editor, contextId } = newEditor();
    const anchor: MarkupAnchor = { ownerHistoryId: 5, storeyPlacementId: 54 };
    const written = addTextMarkupToStore(editor, anchor, contextId, {
      position: { x: 2, y: 3 },
      text: 'Check clearance here',
    });

    const entities = entitiesById(view);
    const builder = newFlatBuilder();
    builder.addText(2, 3, 'Check clearance here', written.annotationId, 1, 0.25);
    const parseResult = buildParseResult(builder.flat, {});

    const meta = metaLookupFromView(view, entities);
    const result = readDrawingMarkupFromParseResult(parseResult, meta, {});

    assert.strictEqual(result.textAnnotations2D.length, 1);
    const t = result.textAnnotations2D[0];
    assert.strictEqual(t.text, 'Check clearance here');
    assert.deepStrictEqual(t.position, { x: 2, y: 3 });
    assert.strictEqual(t.fontSize, 14);
    assert.strictEqual(t.color, '#000000');
  });

  it('rejoins a multi-line literal split by symbolic-parse in original line order', () => {
    const { view, editor, contextId } = newEditor();
    const anchor: MarkupAnchor = { ownerHistoryId: 5, storeyPlacementId: 54 };
    const written = addTextMarkupToStore(editor, anchor, contextId, {
      position: { x: 0, y: 0 },
      text: 'First line\nSecond line\nThird line',
    });
    const entities = entitiesById(view);
    const builder = newFlatBuilder();
    builder.addText(0, 0, 'First line\nSecond line\nThird line', written.annotationId, 1, 0.6);
    const parseResult = buildParseResult(builder.flat, {});
    const meta = metaLookupFromView(view, entities);
    const result = readDrawingMarkupFromParseResult(parseResult, meta, {});

    assert.strictEqual(result.textAnnotations2D.length, 1);
    assert.strictEqual(result.textAnnotations2D[0].text, 'First line\nSecond line\nThird line');
  });
});

// ── Round trip: cloud ───────────────────────────────────────────────────

describe('drawing-markup-read: cloud round trip', () => {
  it('reconstructs a CloudAnnotation2D from its IfcAnnotationFillArea ring', () => {
    const { view, editor, contextId } = newEditor();
    const anchor: MarkupAnchor = { ownerHistoryId: 5, storeyPlacementId: 54 };
    const written = addCloudMarkupToStore(editor, anchor, contextId, {
      points: [{ x: 1, y: 5 }, { x: 4, y: 2 }],
      label: 'Revise per RFI-12',
    });

    const entities = entitiesById(view);
    const fillArea = deref(entities, `#${written.fillAreaId}`);
    const polylineRef = fillArea.attributes[0] as string;
    const polylineId = Number(polylineRef.slice(1));
    const ringPoints = polylinePoints(entities, polylineId);
    assert.strictEqual(ringPoints.length, 5, 'writer emits 4 rectangle corners + 1 closing duplicate');

    const builder = newFlatBuilder();
    builder.addFillRing(ringPoints, written.annotationId, 1);
    const parseResult = buildParseResult(builder.flat, {});

    const meta = metaLookupFromView(view, entities);
    const result = readDrawingMarkupFromParseResult(parseResult, meta, {});

    assert.strictEqual(result.cloudAnnotations2D.length, 1);
    const c = result.cloudAnnotations2D[0];
    assert.deepStrictEqual(c.points, [{ x: 1, y: 5 }, { x: 4, y: 2 }]);
    assert.strictEqual(c.label, 'Revise per RFI-12');
    assert.strictEqual(c.color, '#E53935');
  });
});

// ── Untagged annotations must be ignored, unchanged ────────────────────

describe('drawing-markup-read: untagged annotations', () => {
  it('ignores an IfcAnnotation with no ObjectType tag', () => {
    const { view, editor, contextId } = newEditor();
    // A generic annotation authored by another tool: same shape, but no
    // DRAWING_MARKUP_OBJECTTYPE tag and no Qto_IfcLiteMarkup quantity set.
    const anchor: MarkupAnchor = { ownerHistoryId: 5, storeyPlacementId: 54 };
    const measure = addMeasureMarkupToStore(editor, anchor, contextId, {
      start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, distance: 1,
    });
    const entities = entitiesById(view);
    // Overwrite the tag to simulate a foreign, untagged annotation.
    const annotation = entities.get(measure.annotationId)!;
    (annotation.attributes as unknown[])[4] = null;

    const builder = newFlatBuilder();
    const points = polylinePoints(entities, measure.polylineId);
    builder.addPolyline(points, measure.annotationId, 1);
    const parseResult = buildParseResult(builder.flat, {});
    const meta = metaLookupFromView(view, entities);

    const result = readDrawingMarkupFromParseResult(parseResult, meta, {});
    assert.strictEqual(result.measure2DResults.length, 0);
    assert.strictEqual(result.polygonArea2DResults.length, 0);
    assert.strictEqual(result.textAnnotations2D.length, 0);
    assert.strictEqual(result.cloudAnnotations2D.length, 0);

    // The single-annotation dispatcher agrees: untagged is `null`, not an error.
    const source: DrawingMarkupAnnotationSource = {
      expressId: measure.annotationId,
      objectType: null,
      lines: parseResult.loose.length ? parseResult.loose : [...parseResult.byStorey.values()].flatMap((b) => b.lines),
      texts: [],
      fills: [],
      quantities: new Map(),
    };
    assert.strictEqual(readDrawingMarkupAnnotation(source, {}), null);
  });

  it('ignores an ObjectType string that merely resembles a markup tag', () => {
    const source: DrawingMarkupAnnotationSource = {
      expressId: 1,
      objectType: 'IfcLite:Markup:Measurement', // not the exact tag
      lines: [{ line: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }, category: 'annotation', ownerId: 1 }],
      texts: [],
      fills: [],
      quantities: new Map([['Distance', 1]]),
    };
    assert.strictEqual(readDrawingMarkupAnnotation(source, {}), null);
  });
});

// ── Malformed entries are skipped, never thrown ─────────────────────────

describe('drawing-markup-read: malformed entries are skipped without throwing', () => {
  it('skips a MEASURE tag whose quantity set is missing', () => {
    const source: DrawingMarkupAnnotationSource = {
      expressId: 7,
      objectType: DRAWING_MARKUP_OBJECTTYPE.MEASURE,
      lines: [{ line: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }, category: 'annotation', ownerId: 7 }],
      texts: [],
      fills: [],
      quantities: undefined,
    };
    assert.doesNotThrow(() => {
      const read = readDrawingMarkupAnnotation(source, {});
      assert.strictEqual(read, null);
    });
  });

  it('skips a MEASURE tag whose geometry is missing (no polyline segment)', () => {
    const source: DrawingMarkupAnnotationSource = {
      expressId: 8,
      objectType: DRAWING_MARKUP_OBJECTTYPE.MEASURE,
      lines: [],
      texts: [],
      fills: [],
      quantities: new Map([['Distance', 5]]),
    };
    assert.doesNotThrow(() => {
      assert.strictEqual(readDrawingMarkupAnnotation(source, {}), null);
    });
  });

  it('skips a POLYGON_AREA tag with too few points to form a polygon', () => {
    const source: DrawingMarkupAnnotationSource = {
      expressId: 9,
      objectType: DRAWING_MARKUP_OBJECTTYPE.POLYGON_AREA,
      lines: [{ line: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }, category: 'annotation', ownerId: 9 }],
      texts: [],
      fills: [],
      quantities: new Map([['Area', 1], ['Perimeter', 4]]),
    };
    assert.doesNotThrow(() => {
      assert.strictEqual(readDrawingMarkupAnnotation(source, {}), null);
    });
  });

  it('skips a CLOUD tag whose property set is missing (no Label)', () => {
    const source: DrawingMarkupAnnotationSource = {
      expressId: 10,
      objectType: DRAWING_MARKUP_OBJECTTYPE.CLOUD,
      lines: [],
      texts: [],
      fills: [{
        points: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1, 0, 0]),
        holesOffsets: new Uint32Array(0),
        color: [0, 0, 0, 1],
        ownerId: 10,
      }],
      quantities: new Map(),
      properties: undefined,
    };
    assert.doesNotThrow(() => {
      assert.strictEqual(readDrawingMarkupAnnotation(source, {}), null);
    });
  });

  it('skips a TEXT tag with no text primitive (empty literal was dropped upstream)', () => {
    const source: DrawingMarkupAnnotationSource = {
      expressId: 11,
      objectType: DRAWING_MARKUP_OBJECTTYPE.TEXT,
      lines: [],
      texts: [],
      fills: [],
    };
    assert.doesNotThrow(() => {
      assert.strictEqual(readDrawingMarkupAnnotation(source, {}), null);
    });
  });
});

// ── Hand-written fixture (not produced by this suite's own writer calls) ─

describe('drawing-markup-read: hand-written fixture', () => {
  it('reads a measure markup authored directly against the mutation-view API, bypassing addMeasureMarkupToStore', () => {
    // Hand-author the same entity shape `emitAnnotation`/`addMeasureMarkupToStore`
    // would produce, without calling either — an independent check that the
    // reader's contract (ObjectType at attribute index 4, Qto_IfcLiteMarkup
    // "Distance") matches the real IFC shape, not just this suite's own writer.
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(50), view);
    const p1 = editor.addEntity('IfcCartesianPoint', [[10, 20]]).expressId;
    const p2 = editor.addEntity('IfcCartesianPoint', [[13, 24]]).expressId;
    const polylineId = editor.addEntity('IfcPolyline', [[`#${p1}`, `#${p2}`]]).expressId;
    const shapeRepId = editor.addEntity('IfcShapeRepresentation', [
      '#14', 'Annotation', 'Curve2D', [`#${polylineId}`],
    ]).expressId;
    const productShapeId = editor.addEntity('IfcProductDefinitionShape', [null, null, [`#${shapeRepId}`]]).expressId;
    const placementId = editor.addEntity('IfcLocalPlacement', [null, null]).expressId;
    const annotationId = editor.addEntity('IfcAnnotation', [
      '3xxxxxxxxxxxxxxxxxxxxxxxxx', null, 'Measurement', null,
      DRAWING_MARKUP_OBJECTTYPE.MEASURE, `#${placementId}`, `#${productShapeId}`,
    ]).expressId;
    // Geometric distance between the two points is exactly 5
    // (sqrt(3^2 + 4^2)); store a deliberately DIFFERENT value to prove the
    // reader trusts the quantity set rather than recomputing from points
    // (this file's "trust or recompute" decision — see drawing-markup-read.ts).
    editor.addQuantitySet(annotationId, DRAWING_MARKUP_QSET_NAME, [
      { name: 'Distance', value: 5.2, quantityType: 'LENGTH' },
    ]);

    const entities = entitiesById(view);
    const builder = newFlatBuilder();
    builder.addPolyline([[10, 20], [13, 24]], annotationId, 1);
    const parseResult = buildParseResult(builder.flat, {});
    const meta = metaLookupFromView(view, entities);

    const result = readDrawingMarkupFromParseResult(parseResult, meta, {});
    assert.strictEqual(result.measure2DResults.length, 1);
    const m = result.measure2DResults[0];
    assert.deepStrictEqual(m.start, { x: 10, y: 20 });
    assert.deepStrictEqual(m.end, { x: 13, y: 24 });
    // Trusted stored value (5.2) wins over the geometric recompute (5) —
    // a console.warn fires for the mismatch but the value is not overridden.
    assert.strictEqual(m.distance, 5.2);
  });
});

// ── warnOnDerivedValueMismatch actually fires (the reader's own evidence
//    mechanism — nothing else in this suite spies on console.warn) ────────

describe('drawing-markup-read: the stored-vs-computed mismatch warning fires', () => {
  it('warns when a positive stored Distance disagrees with the geometry beyond tolerance', () => {
    const source: DrawingMarkupAnnotationSource = {
      expressId: 30,
      objectType: DRAWING_MARKUP_OBJECTTYPE.MEASURE,
      // Geometric distance is exactly 5 (3-4-5 triangle); stored Distance
      // (5.2) disagrees well beyond the 1e-3 relative tolerance.
      lines: [{ line: { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } }, category: 'annotation', ownerId: 30 }],
      texts: [],
      fills: [],
      quantities: new Map([['Distance', 5.2]]),
    };

    const read = withWarnSpy((calls) => {
      const r = readDrawingMarkupAnnotation(source, {});
      assert.strictEqual(calls.length, 1, 'expected exactly one console.warn call for the mismatch');
      assert.match(String(calls[0][0]), /disagrees with the/);
      assert.match(String(calls[0][0]), /Distance/);
      return r;
    });

    assert.ok(read && read.kind === 'measure');
    // The trusted value still wins — the warning is evidence, not an override.
    assert.strictEqual(read.value.distance, 5.2);
  });

  it('is a no-op — the control — when stored and computed agree within tolerance', () => {
    const source: DrawingMarkupAnnotationSource = {
      expressId: 31,
      objectType: DRAWING_MARKUP_OBJECTTYPE.MEASURE,
      lines: [{ line: { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } }, category: 'annotation', ownerId: 31 }],
      texts: [],
      fills: [],
      quantities: new Map([['Distance', 5]]),
    };

    withWarnSpy((calls) => {
      readDrawingMarkupAnnotation(source, {});
      assert.deepStrictEqual(calls, [], 'agreeing values must not warn');
    });
  });
});

// ── Non-positive stored quantities are not trusted (Distance/Area/Perimeter
//    <= 0 can never be a real measurement — fall back to the geometry) ────

describe('drawing-markup-read: non-positive stored quantities are not trusted', () => {
  it('falls back to the geometry-derived value when stored Distance is negative', () => {
    const source: DrawingMarkupAnnotationSource = {
      expressId: 40,
      objectType: DRAWING_MARKUP_OBJECTTYPE.MEASURE,
      lines: [{ line: { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } }, category: 'annotation', ownerId: 40 }],
      texts: [],
      fills: [],
      quantities: new Map([['Distance', -5]]),
    };

    const read = withWarnSpy((calls) => {
      const r = readDrawingMarkupAnnotation(source, {});
      assert.strictEqual(calls.length, 1, 'expected exactly one console.warn call for the invalid value');
      assert.match(String(calls[0][0]), /not a physically valid/);
      return r;
    });

    assert.ok(read && read.kind === 'measure');
    assert.ok(Math.abs(read.value.distance - 5) < 1e-9, `distance was ${read.value.distance}`);
  });

  it('falls back to the geometry-derived value when stored Distance is zero', () => {
    const source: DrawingMarkupAnnotationSource = {
      expressId: 41,
      objectType: DRAWING_MARKUP_OBJECTTYPE.MEASURE,
      lines: [{ line: { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } }, category: 'annotation', ownerId: 41 }],
      texts: [],
      fills: [],
      quantities: new Map([['Distance', 0]]),
    };

    const read = readDrawingMarkupAnnotation(source, {});
    assert.ok(read && read.kind === 'measure');
    assert.ok(Math.abs(read.value.distance - 5) < 1e-9, `distance was ${read.value.distance}`);
  });

  it('leaves a truly degenerate (coincident-point) measure at its real, computed zero distance', () => {
    // Not a corrupted-value case: the geometry itself is degenerate (start
    // === end). A stored, untrustworthy negative value still falls back to
    // the geometry-derived value — which is honestly 0 here, not a lie.
    const source: DrawingMarkupAnnotationSource = {
      expressId: 42,
      objectType: DRAWING_MARKUP_OBJECTTYPE.MEASURE,
      lines: [{ line: { start: { x: 2, y: 2 }, end: { x: 2, y: 2 } }, category: 'annotation', ownerId: 42 }],
      texts: [],
      fills: [],
      quantities: new Map([['Distance', -1]]),
    };

    const read = readDrawingMarkupAnnotation(source, {});
    assert.ok(read && read.kind === 'measure');
    assert.strictEqual(read.value.distance, 0);
  });

  it('falls back to the geometry-derived Area and Perimeter when both are stored non-positive', () => {
    // A 4x3 rectangle: real area 12, real perimeter 14 (matches the round
    // trip fixture above), but the stored quantities are corrupted negative.
    const source: DrawingMarkupAnnotationSource = {
      expressId: 43,
      objectType: DRAWING_MARKUP_OBJECTTYPE.POLYGON_AREA,
      lines: [
        { line: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } }, category: 'annotation', ownerId: 43 },
        { line: { start: { x: 4, y: 0 }, end: { x: 4, y: 3 } }, category: 'annotation', ownerId: 43 },
        { line: { start: { x: 4, y: 3 }, end: { x: 0, y: 3 } }, category: 'annotation', ownerId: 43 },
        { line: { start: { x: 0, y: 3 }, end: { x: 0, y: 0 } }, category: 'annotation', ownerId: 43 },
      ],
      texts: [],
      fills: [],
      quantities: new Map([['Area', -12], ['Perimeter', -14]]),
    };

    const read = withWarnSpy((calls) => {
      const r = readDrawingMarkupAnnotation(source, {});
      assert.strictEqual(calls.length, 2, 'expected one warning each for Area and Perimeter');
      return r;
    });

    assert.ok(read && read.kind === 'polygon');
    assert.ok(Math.abs(read.value.area - 12) < 1e-9, `area was ${read.value.area}`);
    assert.ok(Math.abs(read.value.perimeter - 14) < 1e-9, `perimeter was ${read.value.perimeter}`);
  });
});
