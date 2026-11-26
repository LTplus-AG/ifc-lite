/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { effectiveMetadataRecord, extractPropertiesOnDemand, extractQuantitiesOnDemand, ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import { currentProjectUnitContext } from '@/lib/units/current-project-unit-context';
import { resolveQuantityDisplay } from '@/lib/units/display';
import type { Drawing2D, DrawingPolygon } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { toGlobalIdForRef } from '@/store/globalId';
import type { Point2D, TagAnnotation2D, TextAnnotation2D } from '@/store/slices/drawing2DSlice';

/** True unless the first IfcProject's UnitsInContext is explicitly unset ($). */
function projectDeclaresUnits(store: IfcDataStore, view: Parameters<typeof effectiveMetadataRecord>[2]): boolean {
  const id = store.entityIndex.byType.get('IFCPROJECT')?.[0];
  if (id === undefined) return true;
  const record = effectiveMetadataRecord(store, id, view);
  return !record || record.attributes[record.names.indexOf('UnitsInContext')] !== null;
}

/** Live IFC values, including named/positional edits and overlay-created entities. */
export function resolveElementTagLabel(tag: TagAnnotation2D): string | null {
  const state = useViewerStore.getState();
  const store = tag.modelId === 'legacy' ? state.ifcDataStore : state.models.get(tag.modelId)?.ifcDataStore;
  if (!store) return null;
  const view = state.mutationViews.get(tag.modelId === 'legacy' ? '__legacy__' : tag.modelId);
  const record = effectiveMetadataRecord(store, tag.entityId, view);
  if (!record || !['IfcDoor', 'IfcWindow', 'IfcSpace'].includes(record.type)) return null;
  const attr = (name: string) => {
    const value = record.attributes[record.names.indexOf(name)];
    return typeof value === 'string' ? value.trim() : '';
  };
  const name = attr('Name');
  if (record.type !== 'IfcSpace') {
    const sets = view ? view.getForEntity(tag.entityId) : extractPropertiesOnDemand(store, tag.entityId);
    const mark = sets.flatMap(set => set.properties).find(prop => prop.name === 'Mark' && String(prop.value ?? '').trim());
    // IFC's canonical occurrence mark is IfcElement.Tag; authoring tools also use a Mark property.
    return attr('Tag') || (mark ? String(mark.value) : '') || name || record.type;
  }
  const base = (id: number) => extractQuantitiesOnDemand(store, id);
  const sets = view ? view.getQuantitiesForEntity(tag.entityId, view.hasQuantityBase() ? undefined : base) : base(tag.entityId);
  const quantity = sets.filter(set => set.name === 'Qto_SpaceBaseQuantities')
    .flatMap(set => set.quantities).find(candidate => candidate.name === 'NetFloorArea');
  const title = name || 'IfcSpace';
  if (!quantity || typeof quantity.value !== 'number' || !Number.isFinite(quantity.value)) return title;
  // The value is in the file's own AREAUNIT (or the quantity's explicit Unit), never pre-converted to m².
  const context = currentProjectUnitContext(store, view);
  // A project with no UnitsInContext (optional in IFC4) declares nothing, so SI defaults apply, as for geometry.
  const unitsKnown = context.status !== 'unavailable' || !projectDeclaresUnits(store, view);
  const units = context.value ?? ProjectUnits.empty();
  const { unit } = resolveQuantityDisplay(quantity.value, QuantityType.Area, units, {}, quantity, unitsKnown);
  // Declared but unreadable units show no area rather than a number under a guessed unit.
  return unit ? `${title} · ≈ ${Number(quantity.value.toFixed(2))} ${unit}` : title;
}

/** Area-weighted cut centroid. All fragments contribute, so tessellation order cannot move a tag. */
export function resolveElementTagAnchor(tag: TagAnnotation2D, polygons: readonly DrawingPolygon[], globalId: number): Point2D {
  let area = 0, x = 0, y = 0;
  const fragments = polygons.filter(polygon => polygon.entityId === globalId);
  const cuts = fragments.filter(polygon => polygon.isCut);
  for (const polygon of cuts.length > 0 ? cuts : fragments) {
    for (const [ringIndex, ring] of [polygon.polygon.outer, ...polygon.polygon.holes].entries()) {
      let a = 0, cx = 0, cy = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const cross = p.x * q.y - q.x * p.y;
        a += cross; cx += (p.x + q.x) * cross; cy += (p.y + q.y) * cross;
      }
      if (Math.abs(a) < 1e-12) continue;
      const weight = Math.abs(a) * (ringIndex === 0 ? 1 : -1);
      x += cx / (3 * a) * weight; y += cy / (3 * a) * weight; area += weight;
    }
  }
  const anchor = area > 1e-12 ? { x: x / area, y: y / area } : tag.anchor;
  return { x: anchor.x + tag.offset.x, y: anchor.y + tag.offset.y };
}

/** One resolved representation feeds canvas, SVG, both PDFs and DXF. Never persisted as text. */
export function resolvedElementTags(drawing: Drawing2D): TextAnnotation2D[] {
  const state = useViewerStore.getState();
  return state.tagAnnotations2D.flatMap(tag => {
    const text = resolveElementTagLabel(tag);
    if (text === null) return [];
    const globalId = toGlobalIdForRef(state.models, { modelId: tag.modelId, expressId: tag.entityId });
    return [{ id: tag.id, text, position: resolveElementTagAnchor(tag, [...drawing.cutPolygons, ...drawing.projectionPolygons], globalId),
      fontSize: 14, color: '#000000', backgroundColor: 'rgba(255,255,255,0.9)', borderColor: '#333333' }];
  });
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
export function elementTagsSvg(tags: readonly TextAnnotation2D[], map: (x: number, y: number) => Point2D, height: number): string {
  return `<g id="element-tags" fill="#000" font-family="sans-serif" font-size="${height}">` + tags.map(tag => {
    const p = map(tag.position.x, tag.position.y);
    return `<text x="${p.x}" y="${p.y}">${escapeXml(tag.text)}</text>`;
  }).join('') + '</g>\n';
}
