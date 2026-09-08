/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import {
  addDrawingMarkupToStore,
  addMeasureMarkupToStore,
  addPolygonAreaMarkupToStore,
  addTextMarkupToStore,
  addCloudMarkupToStore,
  DRAWING_MARKUP_OBJECTTYPE,
  DRAWING_MARKUP_QSET_NAME,
  DRAWING_MARKUP_PSET_NAME,
  type MarkupAnchor,
} from './drawing-markup.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

const ANCHOR: MarkupAnchor = { ownerHistoryId: 5, storeyPlacementId: 54 };
const ROOT_CONTEXT_ID = 14;

function byId(view: MutablePropertyView) {
  return new Map(view.getNewEntities().map((e) => [e.expressId, e]));
}

const namedQ = (view: MutablePropertyView, id: number): Record<string, number> => {
  const qto = view.getQuantitiesForEntity(id).find((s) => s.name === DRAWING_MARKUP_QSET_NAME);
  return Object.fromEntries((qto?.quantities ?? []).map((q) => [q.name, q.value]));
};

const namedP = (view: MutablePropertyView, id: number): Record<string, unknown> => {
  const pset = view.getForEntity(id).find((s) => s.name === DRAWING_MARKUP_PSET_NAME);
  return Object.fromEntries((pset?.properties ?? []).map((p) => [p.name, p.value]));
};

describe('drawing-markup tag values (round-trip readiness)', () => {
  // Pinned literals: a future read-side translator imports DRAWING_MARKUP_OBJECTTYPE
  // rather than re-declaring these strings — a silent rename here must go RED.
  it('pins the exact ObjectType tag strings', () => {
    expect(DRAWING_MARKUP_OBJECTTYPE.MEASURE).toBe('IfcLite:Markup:Measure');
    expect(DRAWING_MARKUP_OBJECTTYPE.POLYGON_AREA).toBe('IfcLite:Markup:PolygonArea');
    expect(DRAWING_MARKUP_OBJECTTYPE.TEXT).toBe('IfcLite:Markup:Text');
    expect(DRAWING_MARKUP_OBJECTTYPE.CLOUD).toBe('IfcLite:Markup:Cloud');
  });
});

describe('addMeasureMarkupToStore', () => {
  it('emits an IfcAnnotation tagged MEASURE with an IfcPolyline through start/end, in order', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const contextId = editor.addEntity('IfcGeometricRepresentationSubContext', [
      'Annotation', 'Model', '*', '*', '*', '*', `#${ROOT_CONTEXT_ID}`, null, '.PLAN_VIEW.', null,
    ]).expressId;

    const result = addMeasureMarkupToStore(editor, ANCHOR, contextId, {
      start: { x: 1, y: 2 },
      end: { x: 5, y: 7 },
      distance: 6.4,
    });

    const entities = byId(view);
    const annotation = entities.get(result.annotationId);
    expect(annotation?.type).toBe('IfcAnnotation');
    expect(annotation?.attributes[4]).toBe(DRAWING_MARKUP_OBJECTTYPE.MEASURE); // ObjectType
    expect(annotation?.attributes[6]).toBe(`#${result.productShapeId}`); // Representation

    const polyline = entities.get(result.polylineId);
    expect(polyline?.type).toBe('IfcPolyline');
    const pointRefs = polyline?.attributes[0] as string[];
    expect(pointRefs).toHaveLength(2);
    const points = pointRefs.map((ref) => {
      const pid = Number(ref.slice(1));
      return entities.get(pid)?.attributes[0] as [number, number];
    });
    expect(points[0]).toEqual([1, 2]);
    expect(points[1]).toEqual([5, 7]);

    expect(namedQ(view, result.annotationId)['Distance']).toBeCloseTo(6.4, 6);
  });
});

describe('addPolygonAreaMarkupToStore', () => {
  it('emits a closed IfcPolyline preserving vertex order, tagged POLYGON_AREA', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const contextId = editor.addEntity('IfcGeometricRepresentationSubContext', [
      'Annotation', 'Model', '*', '*', '*', '*', `#${ROOT_CONTEXT_ID}`, null, '.PLAN_VIEW.', null,
    ]).expressId;

    const result = addPolygonAreaMarkupToStore(editor, ANCHOR, contextId, {
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
      area: 12,
      perimeter: 14,
    });

    const entities = byId(view);
    expect(entities.get(result.annotationId)?.attributes[4]).toBe(DRAWING_MARKUP_OBJECTTYPE.POLYGON_AREA);
    const polyline = entities.get(result.polylineId);
    const pointRefs = polyline?.attributes[0] as string[];
    // 4 input vertices + auto-closed repeat of the first
    expect(pointRefs).toHaveLength(5);
    const first = entities.get(Number(pointRefs[0].slice(1)))?.attributes[0];
    const last = entities.get(Number(pointRefs[4].slice(1)))?.attributes[0];
    expect(first).toEqual(last);
    const second = entities.get(Number(pointRefs[1].slice(1)))?.attributes[0];
    expect(second).toEqual([4, 0]);

    const q = namedQ(view, result.annotationId);
    expect(q['Area']).toBeCloseTo(12, 6);
    expect(q['Perimeter']).toBeCloseTo(14, 6);
  });

  it('does not duplicate the closing vertex when the input polygon is already closed', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const contextId = editor.addEntity('IfcGeometricRepresentationSubContext', [
      'Annotation', 'Model', '*', '*', '*', '*', `#${ROOT_CONTEXT_ID}`, null, '.PLAN_VIEW.', null,
    ]).expressId;

    // Already closed: last point repeats the first, bit-identical.
    const result = addPolygonAreaMarkupToStore(editor, ANCHOR, contextId, {
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }, { x: 0, y: 0 }],
      area: 12,
      perimeter: 14,
    });

    const entities = byId(view);
    const polyline = entities.get(result.polylineId);
    const pointRefs = polyline?.attributes[0] as string[];
    // 5 input vertices, no extra closing vertex appended.
    expect(pointRefs).toHaveLength(5);
    const first = entities.get(Number(pointRefs[0].slice(1)))?.attributes[0];
    const last = entities.get(Number(pointRefs[4].slice(1)))?.attributes[0];
    expect(first).toEqual(last);
  });

  // POINT_EPSILON in drawing-markup-geometry.ts is 1e-6: a last point within
  // that of the first counts as "already closed" and is not duplicated.
  it('treats a last point within POINT_EPSILON of the first as already closed', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const contextId = editor.addEntity('IfcGeometricRepresentationSubContext', [
      'Annotation', 'Model', '*', '*', '*', '*', `#${ROOT_CONTEXT_ID}`, null, '.PLAN_VIEW.', null,
    ]).expressId;

    const result = addPolygonAreaMarkupToStore(editor, ANCHOR, contextId, {
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }, { x: 1e-7, y: -1e-7 }],
      area: 12,
      perimeter: 14,
    });

    const entities = byId(view);
    const polyline = entities.get(result.polylineId);
    const pointRefs = polyline?.attributes[0] as string[];
    // Still 5 vertices: the near-duplicate last point is accepted as the
    // close and nothing further is appended.
    expect(pointRefs).toHaveLength(5);
  });
});

describe('addTextMarkupToStore', () => {
  it('emits an IfcTextLiteralWithExtent carrying the literal text, tagged TEXT', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const contextId = editor.addEntity('IfcGeometricRepresentationSubContext', [
      'Annotation', 'Model', '*', '*', '*', '*', `#${ROOT_CONTEXT_ID}`, null, '.PLAN_VIEW.', null,
    ]).expressId;

    const result = addTextMarkupToStore(editor, ANCHOR, contextId, {
      position: { x: 2, y: 3 },
      text: 'Check this detail',
    });

    const entities = byId(view);
    expect(entities.get(result.annotationId)?.attributes[4]).toBe(DRAWING_MARKUP_OBJECTTYPE.TEXT);
    const literal = entities.get(result.textLiteralId);
    expect(literal?.type).toBe('IfcTextLiteralWithExtent');
    expect(literal?.attributes[0]).toBe('Check this detail');
  });
});

describe('addCloudMarkupToStore', () => {
  it('emits an IfcAnnotationFillArea over the rectangle corners, tagged CLOUD, preserving the label', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const contextId = editor.addEntity('IfcGeometricRepresentationSubContext', [
      'Annotation', 'Model', '*', '*', '*', '*', `#${ROOT_CONTEXT_ID}`, null, '.PLAN_VIEW.', null,
    ]).expressId;

    const result = addCloudMarkupToStore(editor, ANCHOR, contextId, {
      points: [{ x: 0, y: 0 }, { x: 2, y: 1 }],
      label: 'Revise wall type',
    });

    const entities = byId(view);
    expect(entities.get(result.annotationId)?.attributes[4]).toBe(DRAWING_MARKUP_OBJECTTYPE.CLOUD);
    const fillArea = entities.get(result.fillAreaId);
    expect(fillArea?.type).toBe('IfcAnnotationFillArea');
    expect(fillArea?.attributes[0]).toBe(`#${result.polylineId}`);

    const polyline = entities.get(result.polylineId);
    const pointRefs = polyline?.attributes[0] as string[];
    const corners = pointRefs.map((ref) => entities.get(Number(ref.slice(1)))?.attributes[0]);
    expect(corners[0]).toEqual([0, 0]); // topLeft
    expect(corners[1]).toEqual([2, 0]); // topRight
    expect(corners[2]).toEqual([2, 1]); // bottomRight
    expect(corners[3]).toEqual([0, 1]); // bottomLeft
    expect(corners[4]).toEqual([0, 0]); // closed back to topLeft

    expect(namedP(view, result.annotationId)['Label']).toBe('Revise wall type');
  });

  // The cloud rectangle's 4 corners are [topLeft, (br.x,tl.y), bottomRight,
  // (tl.x,br.y)]; corner[0] and corner[3] are only bit-identical when
  // bottomRight.y === topLeft.y (a zero-height rectangle) — that's the only
  // shape of cloud input that exercises emitMarkupPolyline's shared
  // already-closed guard (same guard addPolygonAreaMarkupToStore uses).
  it('does not duplicate the closing vertex for a degenerate zero-height cloud rectangle', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const contextId = editor.addEntity('IfcGeometricRepresentationSubContext', [
      'Annotation', 'Model', '*', '*', '*', '*', `#${ROOT_CONTEXT_ID}`, null, '.PLAN_VIEW.', null,
    ]).expressId;

    const result = addCloudMarkupToStore(editor, ANCHOR, contextId, {
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }],
      label: 'Zero-height cloud',
    });

    const entities = byId(view);
    const polyline = entities.get(result.polylineId);
    const pointRefs = polyline?.attributes[0] as string[];
    // 4 rectangle corners, no extra closing vertex appended.
    expect(pointRefs).toHaveLength(4);
    const first = entities.get(Number(pointRefs[0].slice(1)))?.attributes[0];
    const last = entities.get(Number(pointRefs[3].slice(1)))?.attributes[0];
    expect(first).toEqual(last);
  });
});

describe('addDrawingMarkupToStore (batch, additivity)', () => {
  it('translates one of each kind and creates exactly one shared subcontext', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);

    const result = addDrawingMarkupToStore(editor, ANCHOR, ROOT_CONTEXT_ID, {
      measure2DResults: [{ id: 'm1', start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 }],
      polygonArea2DResults: [{ id: 'p1', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], area: 2, perimeter: 6.83 }],
      textAnnotations2D: [{ id: 't1', position: { x: 1, y: 1 }, text: 'Note' }],
      cloudAnnotations2D: [{ id: 'c1', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], label: 'Cloud' }],
    });

    expect(result.measures).toHaveLength(1);
    expect(result.polygons).toHaveLength(1);
    expect(result.texts).toHaveLength(1);
    expect(result.clouds).toHaveLength(1);

    const entities = byId(view);
    const subContexts = view.getNewEntities().filter((e) => e.type === 'IfcGeometricRepresentationSubContext');
    expect(subContexts).toHaveLength(1);
    expect(subContexts[0].expressId).toBe(result.subContextId);
    expect(entities.get(result.subContextId)?.attributes[6]).toBe(`#${ROOT_CONTEXT_ID}`); // ParentContext
    expect(entities.get(result.subContextId)?.attributes[8]).toBe('.PLAN_VIEW.'); // TargetView

    // Every reference from the new entities either points at another new
    // entity, or at one of the two pre-existing anchor entities referenced
    // (the root context and the storey placement every annotation chains
    // its own IfcLocalPlacement from).
    const newIds = new Set(view.getNewEntities().map((e) => e.expressId));
    const preExistingRefs = new Set([ROOT_CONTEXT_ID, ANCHOR.storeyPlacementId, ANCHOR.ownerHistoryId as number]);
    const refsOf = (v: unknown, acc: number[] = []): number[] => {
      if (typeof v === 'string' && /^#\d+$/.test(v)) acc.push(Number(v.slice(1)));
      else if (Array.isArray(v)) for (const item of v) refsOf(item, acc);
      return acc;
    };
    for (const entity of view.getNewEntities()) {
      for (const ref of refsOf(entity.attributes)) {
        expect(preExistingRefs.has(ref) || newIds.has(ref)).toBe(true);
      }
    }
  });

  it('is additive: express ids never collide with the pre-existing store, and no pre-existing entity is touched', () => {
    const preExistingMax = 40;
    const store = makeStore(preExistingMax);
    // `MutationEntityByIdIndex` only guarantees get/has/size/keys() (see its
    // JSDoc) — not iteration or Symbol.iterator — so snapshot through those
    // read methods rather than `new Map(store.entityIndex.byId)`.
    const snapshot = new Map<number, MutationEntityRef | undefined>(
      Array.from(store.entityIndex.byId.keys(), (id) => [id, store.entityIndex.byId.get(id)] as const),
    );
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    addDrawingMarkupToStore(editor, ANCHOR, ROOT_CONTEXT_ID, {
      measure2DResults: [{ id: 'm1', start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 }],
      polygonArea2DResults: [{ id: 'p1', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], area: 2, perimeter: 6.83 }],
      textAnnotations2D: [{ id: 't1', position: { x: 1, y: 1 }, text: 'Note' }],
      cloudAnnotations2D: [{ id: 'c1', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], label: 'Cloud' }],
    });

    // Nothing in the ORIGINAL store map was mutated (no key removed/changed).
    expect(store.entityIndex.byId.size).toBe(preExistingMax);
    for (const [id, ref] of snapshot) {
      expect(store.entityIndex.byId.get(id)).toEqual(ref);
    }

    // No new overlay expressId collides with a pre-existing one.
    for (const entity of view.getNewEntities()) {
      expect(entity.expressId).toBeGreaterThan(preExistingMax);
    }

    // No overlay-modification records exist for any pre-existing entity —
    // this translation only calls addEntity/addQuantitySet/addPropertySet on
    // its OWN freshly-created ids, never setAttribute/setPositionalAttribute
    // on something already in the store.
    for (let id = 1; id <= preExistingMax; id++) {
      expect(view.getPositionalMutationsForEntity(id)).toBeNull();
    }
  });
});

describe('addPolygonAreaMarkupToStore: points.length < 3 guard', () => {
  it('throws for 2 points', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    expect(() =>
      addPolygonAreaMarkupToStore(editor, ANCHOR, ROOT_CONTEXT_ID, {
        points: [{ x: 0, y: 0 }, { x: 4, y: 0 }],
        area: 12,
        perimeter: 14,
      }),
    ).toThrow(/needs at least 3 points/);
  });

  it('throws for 0 points', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    expect(() =>
      addPolygonAreaMarkupToStore(editor, ANCHOR, ROOT_CONTEXT_ID, {
        points: [],
        area: 12,
        perimeter: 14,
      }),
    ).toThrow(/needs at least 3 points/);
  });

  it('accepts exactly 3 points (the boundary)', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    expect(() =>
      addPolygonAreaMarkupToStore(editor, ANCHOR, ROOT_CONTEXT_ID, {
        points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }],
        area: 6,
        perimeter: 12,
      }),
    ).not.toThrow();
  });
});

// ============================================================================
// Finiteness guards (NaN/Infinity coordinates and derived quantities).
//
// A raw NaN/Infinity coordinate previously reached `IfcCartesianPoint` as a
// bare number, which the STEP writer serializes as the literal `$` (STEP's
// "no value" token) inside a mandatory-REAL attribute list — schema-invalid
// STEP written with no error. A NaN distance/area/perimeter similarly
// reached `IfcQuantityLength`/`IfcQuantityArea` unguarded. Coordinates only
// reject non-finite (negative/zero is legitimate drawing-space input, see
// `spatial-zone.ts`'s Footprint-point guard); distance/area/perimeter/extent
// additionally reject negative (legitimately zero, but never negative).
// ============================================================================

describe('finiteness guards', () => {
  describe('addMeasureMarkupToStore', () => {
    it('rejects a non-finite start point', () => {
      expect(() =>
        addMeasureMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          start: { x: NaN, y: 0 }, end: { x: 5, y: 7 }, distance: 6.4,
        }),
      ).toThrow(/addMeasureMarkupToStore: start needs a finite point/);
    });

    it('rejects a non-finite end point', () => {
      expect(() =>
        addMeasureMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          start: { x: 1, y: 2 }, end: { x: Infinity, y: 7 }, distance: 6.4,
        }),
      ).toThrow(/addMeasureMarkupToStore: end needs a finite point/);
    });

    it('rejects a non-finite distance', () => {
      expect(() =>
        addMeasureMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          start: { x: 1, y: 2 }, end: { x: 5, y: 7 }, distance: NaN,
        }),
      ).toThrow(/addMeasureMarkupToStore: distance must be finite and non-negative/);
    });

    it('rejects a negative distance', () => {
      expect(() =>
        addMeasureMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          start: { x: 1, y: 2 }, end: { x: 5, y: 7 }, distance: -1,
        }),
      ).toThrow(/addMeasureMarkupToStore: distance must be finite and non-negative/);
    });

    it('accepts negative/zero coordinates and a zero distance', () => {
      expect(() =>
        addMeasureMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          start: { x: -1, y: -1 }, end: { x: 0, y: 0 }, distance: 0,
        }),
      ).not.toThrow();
    });
  });

  describe('addPolygonAreaMarkupToStore', () => {
    it('rejects a non-finite vertex', () => {
      expect(() =>
        addPolygonAreaMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: NaN }],
          area: 12, perimeter: 14,
        }),
      ).toThrow(/addPolygonAreaMarkupToStore: points\[2\] needs a finite point/);
    });

    it('rejects a non-finite area', () => {
      expect(() =>
        addPolygonAreaMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }],
          area: Infinity, perimeter: 14,
        }),
      ).toThrow(/addPolygonAreaMarkupToStore: area must be finite and non-negative/);
    });

    it('rejects a non-finite perimeter', () => {
      expect(() =>
        addPolygonAreaMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }],
          area: 12, perimeter: NaN,
        }),
      ).toThrow(/addPolygonAreaMarkupToStore: perimeter must be finite and non-negative/);
    });

    it('accepts negative/zero vertex coordinates', () => {
      expect(() =>
        addPolygonAreaMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          points: [{ x: -1, y: -1 }, { x: 4, y: 0 }, { x: 4, y: 3 }],
          area: 0, perimeter: 0,
        }),
      ).not.toThrow();
    });
  });

  describe('addTextMarkupToStore', () => {
    it('rejects a non-finite position', () => {
      expect(() =>
        addTextMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          position: { x: NaN, y: 3 }, text: 'note',
        }),
      ).toThrow(/addTextMarkupToStore: position needs a finite point/);
    });

    it('rejects a non-finite extent', () => {
      expect(() =>
        addTextMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          position: { x: 2, y: 3 }, text: 'note', extent: { sizeX: Infinity, sizeY: 0.25 },
        }),
      ).toThrow(/addTextMarkupToStore: extent\.sizeX must be finite and non-negative/);
    });

    it('rejects a negative extent', () => {
      expect(() =>
        addTextMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          position: { x: 2, y: 3 }, text: 'note', extent: { sizeX: 1, sizeY: -0.25 },
        }),
      ).toThrow(/addTextMarkupToStore: extent\.sizeY must be finite and non-negative/);
    });

    it('accepts a negative/zero position and the default extent', () => {
      expect(() =>
        addTextMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          position: { x: -1, y: -1 }, text: 'note',
        }),
      ).not.toThrow();
    });
  });

  describe('addCloudMarkupToStore', () => {
    it('rejects a non-finite corner', () => {
      expect(() =>
        addCloudMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          points: [{ x: 0, y: 0 }, { x: NaN, y: 1 }], label: 'cloud',
        }),
      ).toThrow(/addCloudMarkupToStore: points\[1\] needs a finite point/);
    });

    it('accepts negative/zero corners', () => {
      expect(() =>
        addCloudMarkupToStore(new StoreEditor(makeStore(40), new MutablePropertyView(null, 'm1')), ANCHOR, ROOT_CONTEXT_ID, {
          points: [{ x: -1, y: -1 }, { x: 0, y: 0 }], label: 'cloud',
        }),
      ).not.toThrow();
    });
  });

});

// ============================================================================
// STEP-escaping regression: the full write -> `StepExporter` pipeline.
//
// `addTextMarkupToStore`/`addCloudMarkupToStore` store the raw JS string on
// `IfcTextLiteralWithExtent.Literal` / the markup Pset's `Label` — escaping
// only happens downstream, when `StepExporter` serializes the overlay-created
// entity's attributes (`attribute-real-slots.ts` -> `step-serialization.ts`'s
// `escapeStepString`, re-exported from `@ifc-lite/data`). Nothing in this
// package's own suite proved that pipeline actually runs for markup text, so a
// future change to how overlay string attributes serialize could silently
// corrupt a user's saved note with no red test anywhere in this package.
// ============================================================================

/** Minimal IFC4 model with one storey — same fixture `guid-determinism.test.ts`
 *  uses for its own `StepExporter` end-to-end suite. */
const STOREY_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#7),#9);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#8=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#7,$,.MODEL_VIEW.,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
ENDSEC;
END-ISO-10303-21;`;

describe('STEP-escaping regression: text/label round-trip through StepExporter', () => {
  // Apostrophe, backslash, and CJK (non-ASCII) — the same trio
  // `step-serialization.test.ts` exercises directly against `escapeStepString`,
  // here exercised through the real markup-write -> export pipeline instead.
  const RAW_TEXT = "O'Brien\\path 文字";
  // escapeStepString: backslash doubled, apostrophe doubled, each non-ASCII
  // code point wrapped as \X2\<hex>\X0\ (see step-serializers.ts).
  const ESCAPED_TEXT = "O''Brien\\\\path \\X2\\6587\\X0\\\\X2\\5B57\\X0\\";

  async function exportMarkupModel(): Promise<string> {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STOREY_MODEL).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const view = new MutablePropertyView(null, 'm1');
    view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(store, entityId));
    const editor = new StoreEditor(store, view);
    const anchor: MarkupAnchor = resolveSpatialAnchor(store, 30);
    const subContextId = 8; // pre-existing 'Body' IfcGeometricRepresentationSubContext
    addTextMarkupToStore(editor, anchor, subContextId, { position: { x: 1, y: 1 }, text: RAW_TEXT });
    addCloudMarkupToStore(editor, anchor, subContextId, {
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], label: RAW_TEXT,
    });
    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
    return new TextDecoder().decode(result.content);
  }

  it('escapes the IfcTextLiteralWithExtent.Literal exactly, apostrophe/backslash/CJK round-trip', async () => {
    const out = await exportMarkupModel();
    expect(out).toContain(`IFCTEXTLITERALWITHEXTENT('${ESCAPED_TEXT}'`);
    // The raw unescaped form must NOT appear bare in a string literal slot —
    // if it did, the export produced invalid/ambiguous STEP.
    expect(out).not.toContain(`'${RAW_TEXT}'`);
  });

  it('escapes the cloud markup Label (Pset property value) exactly', async () => {
    const out = await exportMarkupModel();
    expect(out).toMatch(/IFCPROPERTYSINGLEVALUE\('Label',\$,IFCTEXT\('/);
    expect(out).toContain(`IFCTEXT('${ESCAPED_TEXT}')`);
  });
});
