/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateIfcGuid } from '@ifc-lite/encoding';
import { MutablePropertyView, StoreEditor, iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { effectiveMetadataRecord, type IfcDataStore } from '@ifc-lite/parser';
import { resolveSpatialAnchor } from '@ifc-lite/create';
import { loadPersistedDimensions, type Dimension2D } from '@/store/slices/drawing2DDimensions';
import type { DrawnSectionPlane, Measure2DResult, TagAnnotation2D, Point2D } from '@/store/slices/drawing2DSlice';
import { dimensionGraphics } from '@/lib/drawing2d-markup/dimension-graphics';
import { customPlaneCenter } from '@/store/slices/section-plane-center';

import { validElementTags } from '@/lib/drawing/tag-persistence';

const OBJECT_TYPE = 'IfcLite:DrawingAnnotation:1';
type Item = { kind: 'measure'; value: Measure2DResult } | { kind: 'dimension'; value: Dimension2D }
  | { kind: 'tag'; value: Omit<TagAnnotation2D, 'modelId'>; label: string };
interface Saved { item: Item; plane: DrawnSectionPlane }
export interface DrawingAnnotations {
  measures: Measure2DResult[];
  dimensions: Dimension2D[];
  tags: { tag: TagAnnotation2D; label: string }[];
  plane: DrawnSectionPlane;
  storeyId: number;
  paperScale: number;
  /** Absolute IFC translation removed from the rendered drawing, metres. */
  ifcOffset?: number[];
  /** Persisted identities actually restored into the drawing session. */
  absorbed?: ReadonlySet<string>;
}

/** Read our editable payload; ordinary imported annotations remain untouched. */
export function readDrawingAnnotations(store: IfcDataStore, view?: MutablePropertyView) {
  const records: { id: number; identity: string; saved: Saved }[] = [];
  for (const { expressId } of iterateEffectiveEntityIds(store, view, ['IFCANNOTATION'])) {
    const record = effectiveMetadataRecord(store, expressId, view);
    if (!record || record.attributes[4] !== OBJECT_TYPE || typeof record.attributes[3] !== 'string') continue;
    try {
      const raw: unknown = JSON.parse(record.attributes[3]);
      if (!raw || typeof raw !== 'object' || !('item' in raw) || !('plane' in raw)) continue;
      const saved = raw as Saved;
      if (!saved.item || !['measure', 'dimension', 'tag'].includes(saved.item.kind)
        || typeof saved.item.value?.id !== 'string') continue;
      if (!validSaved(saved)) continue;
      records.push({ id: expressId, identity: typeof record.attributes[0] === 'string' ? record.attributes[0] : `#${expressId}`, saved });
    } catch (error) {
      console.warn('Cannot restore drawing annotation', expressId, error);
    }
  }
  return records;
}

function validSaved(saved: Saved): boolean {
  const point = (p: Point2D | undefined) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  if (loadPersistedDimensions([{ id: 'plane-check', a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, offset: 0, orientation: 'aligned', plane: saved.plane }]).length !== 1 || !saved.plane) return false;
  const item = saved.item;
  if (item.kind === 'dimension') return loadPersistedDimensions([item.value]).length === 1;
  if (item.kind === 'measure') return point(item.value.start) && point(item.value.end) && Number.isFinite(item.value.distance);
  return typeof item.label === 'string' && validElementTags([{ ...item.value, modelId: 'restored' }]).length === 1;
}

export function restoredDrawingAnnotations(store: IfcDataStore, modelId: string, view?: MutablePropertyView) {
  const records = readDrawingAnnotations(store, view);
  if (!records.length) return null;
  return {
    measure2DResults: records.flatMap(({ saved: { item } }) => item.kind === 'measure' ? [item.value] : []),
    dimensions2D: records.flatMap(({ saved: { item } }) => item.kind === 'dimension' ? [item.value] : []),
    tagAnnotations2D: records.flatMap(({ saved: { item } }) => item.kind === 'tag' ? [{ ...item.value, modelId }] : []),
    drawing2DPlane: records[0].saved.plane,
  };
}

/** Detached export view: exporting never dirties the model or consumes live ids. */
export function prepareDrawingAnnotations(store: IfcDataStore, view: MutablePropertyView | undefined, input: DrawingAnnotations | null): MutablePropertyView | undefined {
  if (!input) return view;
  const items: Item[] = [
    ...input.measures.map(value => ({ kind: 'measure' as const, value })),
    ...input.dimensions.map(value => ({ kind: 'dimension' as const, value })),
    ...input.tags.map(({ tag: { modelId: _modelId, ...value }, label }) => ({ kind: 'tag' as const, value, label })),
  ];
  const existing = readDrawingAnnotations(store, view);
  const key = (item: Item) => `${item.kind}:${item.value.id}`;
  const current = new Set(items.map(key));
  const replaceable = existing.filter(({ identity, saved }) => input.absorbed?.has(identity) || current.has(key(saved.item)));
  if (!items.length && !replaceable.length) return view;
  // Preserve native entity identities and geometry when reopening unchanged IFC.
  if (JSON.stringify(existing.map(({ saved }) => saved.item)) === JSON.stringify(items)
    && existing.every(({ saved }) => JSON.stringify(saved.plane) === JSON.stringify(input.plane))) return view;
  const base = view ?? new MutablePropertyView(store.properties ?? null, 'drawing-export');
  return base.prepareAtomic(draft => {
    const editor = new StoreEditor(store, draft);
    // Only delete the annotation itself: never trust file-supplied resource ids
    // as deletion authority over unrelated entities.
    for (const { id } of replaceable) {
      for (const { expressId } of iterateEffectiveEntityIds(store, draft, ['IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCRELASSIGNSTOPRODUCT'])) {
        const record = effectiveMetadataRecord(store, expressId, draft);
        if (Array.isArray(record?.attributes[4]) && record.attributes[4].length === 1 && record.attributes[4][0] === `#${id}`) editor.removeEntity(expressId);
      }
      editor.removeEntity(id);
    }
    if (!items.length) return draft;
    const anchor = resolveSpatialAnchor(store, input.storeyId, draft);
    if (!anchor.rootContextId) throw new Error('Drawing annotations need a representation context');
    const ref = (id: number) => `#${id}`;
    const add = (type: string, attributes: Parameters<StoreEditor['addEntity']>[1]) => editor.addEntity(type, attributes).expressId;
    const owner = anchor.ownerHistoryId ? ref(anchor.ownerHistoryId) : null;
    const guid = () => generateIfcGuid();
    const context = add('IfcGeometricRepresentationSubContext', ['Annotation', 'Model', '*', '*', '*', '*', ref(anchor.rootContextId), null, '.PLAN_VIEW.', null]);
    const scale = anchor.lengthUnitScale ?? 1;
    for (const item of items) {
      
      const emit = (type: string, attributes: Parameters<StoreEditor['addEntity']>[1]) => {
        return add(type, attributes);
      };
      const plane = item.kind === 'dimension' ? item.value.plane ?? input.plane : input.plane;
      const point = (p: Point2D) => {
        if (![p.x, p.y].every(Number.isFinite)) throw new Error('Drawing annotations need finite points');
        return emit('IfcCartesianPoint', [[p.x / scale, p.y / scale]]);
      };
      const o = drawingPointInIfc({ x: 0, y: 0 }, plane);
      const u = drawingPointInIfc({ x: 1, y: 0 }, plane).map((v, i) => v - o[i]);
      const v = drawingPointInIfc({ x: 0, y: 1 }, plane).map((v, i) => v - o[i]);
      const normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
      const origin = emit('IfcCartesianPoint', [o.map((v, i) => (v + (input.ifcOffset?.[i] ?? 0)) / scale)]);
      const axis = emit('IfcDirection', [normal]);
      const direction = emit('IfcDirection', [u]);
      const axes = emit('IfcAxis2Placement3D', [ref(origin), ref(axis), ref(direction)]);
      const placement = emit('IfcLocalPlacement', [null, ref(axes)]);
      const curves: number[] = [];
      const line = (a: Point2D, b: Point2D) => curves.push(emit('IfcPolyline', [[ref(point(a)), ref(point(b))]]));
      let label: string, at: Point2D, angle = 0;
      if (item.kind === 'measure') {
        line(item.value.start, item.value.end);
        label = `${Math.hypot(item.value.end.x - item.value.start.x, item.value.end.y - item.value.start.y).toFixed(2)} m`;
        at = { x: (item.value.start.x + item.value.end.x) / 2, y: (item.value.start.y + item.value.end.y) / 2 };
      } else if (item.kind === 'dimension') {
        const graphics = dimensionGraphics(item.value, { paperScale: input.paperScale, format: metres => `${metres.toFixed(2)} m` });
        for (const [a, b] of [...graphics.lines, ...graphics.ticks]) line(a, b);
        label = graphics.text.value; at = graphics.text.at; angle = graphics.text.angle;
      } else {
        label = item.label; at = { x: item.value.anchor.x + item.value.offset.x, y: item.value.anchor.y + item.value.offset.y };
      }
      const textDirection = emit('IfcDirection', [[Math.cos(angle), Math.sin(angle)]]);
      const textAxes = emit('IfcAxis2Placement2D', [ref(point(at)), ref(textDirection)]);
      const text = emit('IfcTextLiteral', [label, ref(textAxes), '.RIGHT.']);
      const shape = emit('IfcShapeRepresentation', [ref(context), 'Annotation', 'Annotation2D', [...curves.map(ref), ref(text)]]);
      const product = emit('IfcProductDefinitionShape', [null, null, [ref(shape)]]);
      const attributes = [guid(), owner, label, JSON.stringify({ item, plane: input.plane } satisfies Saved), OBJECT_TYPE, ref(placement), ref(product)];
      if (anchor.schema === 'IFC4X3') attributes.push(null);
      const annotation = add('IfcAnnotation', attributes);
      add('IfcRelContainedInSpatialStructure', [guid(), owner, null, null, [ref(annotation)], ref(item.kind === 'tag' ? containingStorey(store, draft, item.value.entityId) ?? input.storeyId : input.storeyId)]);
      if (item.kind === 'tag') add('IfcRelAssignsToProduct', [guid(), owner, 'Tagged element', null, [ref(annotation)], null, ref(item.value.entityId)]);
    }
    return draft;
  }).result;
}

/** Drawing world is Y-up; IFC is Z-up. Cardinal projections store unflipped coordinates. */
export function drawingPointInIfc(p: Point2D, plane: DrawnSectionPlane): number[] {
  let world: number[];
  if (plane.custom) {
    const c = plane.custom, origin = customPlaneCenter(c);
    world = origin.map((v, i) => v + p.x * c.tangent[i] + p.y * c.bitangent[i]);
  } else if (plane.axis === 'down') world = [p.x, plane.position, p.y];
  else if (plane.axis === 'front') world = [p.x, p.y, plane.position];
  else world = [plane.position, p.y, p.x];
  return [world[0], -world[2], world[1]];
}

function containingStorey(store: IfcDataStore, view: MutablePropertyView, target: number): number | null {
  const parents = new Map<string, number>();
  for (const { expressId, type } of iterateEffectiveEntityIds(store, view, ['IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCRELAGGREGATES'])) {
    const attrs = effectiveMetadataRecord(store, expressId, view)?.attributes;
    if (!attrs) continue;
    const contained = type.toUpperCase() === 'IFCRELCONTAINEDINSPATIALSTRUCTURE';
    const parent = attrs[contained ? 5 : 4], children = attrs[contained ? 4 : 5];
    if (typeof parent !== 'string' || !Array.isArray(children)) continue;
    for (const child of children) if (typeof child === 'string') parents.set(child, Number(parent.slice(1)));
  }
  const visited = new Set<number>();
  for (let id: number | undefined = target; id !== undefined && !visited.has(id); id = parents.get(`#${id}`)) {
    visited.add(id);
    if (effectiveMetadataRecord(store, id, view)?.type.toUpperCase() === 'IFCBUILDINGSTOREY') return id;
  }
  return null;
}
