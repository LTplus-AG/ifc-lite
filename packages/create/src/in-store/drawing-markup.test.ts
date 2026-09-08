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
    const snapshot = new Map(store.entityIndex.byId);
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
