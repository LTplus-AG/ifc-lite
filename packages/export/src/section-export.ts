/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GeometryProcessor } from '@ifc-lite/geometry';
import { IfcParser, EntityExtractor, getAttributeNamesForSchema, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, type IfcAttributeValue } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { pruneReplacedSubgraphs } from './demesh-prune.js';
import type { DemeshApplyReport } from './demesh-writer.js';
import { stepReal } from './step-serialization.js';
import { collectReferencedEntityIds, PRODUCT_TYPES } from './reference-collector.js';

/** Kept half-space `normal · world <= offset`, IFC Z-up, metres. */
export interface SectionExportPlane { normal: readonly [number, number, number]; offset: number }
export interface SectionExportOptions {
  planes: readonly SectionExportPlane[];
  /** `whole` keeps crossing elements complete; both modes omit outside elements. */
  mode?: 'trim' | 'whole';
}
interface Part { positions: number[]; indices: number[]; color: number[]; closed: boolean; faceColors?: number[][] }
interface Plan { replacements: Array<{ expressId: number; parts: Part[] }>; outside: number[] }

/**
 * Crop a completed STEP export, including its applied edits and subset. Only the
 * temporary export store is changed. Exact IFC product types, GlobalIds and
 * semantic relationships survive; replacement geometry retains each product placement in file units.
 */
export async function exportSectionedStep(content: Uint8Array, options: SectionExportOptions) {
  if (options.planes.length === 0) return { content, trimmed: [], outside: [] };
  const processor = new GeometryProcessor();
  let plan: Plan;
  try {
    await processor.init();
    plan = readPlan(processor.planSectionExport(content, JSON.stringify(options.planes), options.mode !== 'whole'));
  } finally {
    processor.dispose();
  }
  if (!plan.replacements.length && !plan.outside.length) return { content, trimmed: [], outside: [] };
  const buffer = new ArrayBuffer(content.byteLength);
  new Uint8Array(buffer).set(content);
  const store = await new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'section-export');
  const editor = new StoreEditor(store, view);
  const extractor = new EntityExtractor(store.source!);
  const entity = (id: number) => {
    // @raw-entity-enumeration-ok point read of the freshly parsed mutation-resolved export source
    const ref = store.entityIndex.byId.get(id);
    if (!ref) throw new Error(`Section export entity #${id} is missing.`);
    return extractor.extractEntity(ref);
  };
  // @raw-entity-enumeration-ok context selection reads the immutable export source before temporary geometry authoring
  const context = [...store.entityIndex.byId].find(([, ref]) => ref.type.toUpperCase() === 'IFCGEOMETRICREPRESENTATIONCONTEXT')?.[0];
  if (context === undefined) throw new Error('Section export requires a geometric representation context.');
  const add = (type: string, args: IfcAttributeValue[]) => `#${editor.addEntity(type, args).expressId}`;
  const point = (p: number[]) => add('IfcCartesianPoint', [p.map(stepReal)]);
  const oldReps = new Map<number, number | null>();
  // The canonical subset retains spatial containers for their relationships.
  // Detach excluded bodies too, so those metadata records cannot leak geometry.
  for (const id of plan.outside) {
    const oldRep = entity(id)?.attributes[6];
    // Alignments can mesh through segment children without a product Representation.
    if (oldRep === null || oldRep === undefined) continue;
    if (typeof oldRep !== 'number') throw new Error('Excluded section product has malformed original Representation.');
    oldReps.set(id, oldRep);
    editor.setPositionalAttribute(id, 6, null);
  }
  const ifc2x3 = store.schemaVersion === 'IFC2X3';
  const styles = new Map<string, string>();
  const styleItem = (item: string, color: number[]) => {
    const key = color.join(',');
    let style = styles.get(key);
    if (!style) {
      const [r,g,b,a] = color;
      const rgb = add('IfcColourRgb', [null, stepReal(r), stepReal(g), stepReal(b)]);
      const shading = ifc2x3 ? add('IfcSurfaceStyleRendering', [rgb, stepReal(1-a), null, null, null, null, null, null, '.NOTDEFINED.'])
        : add('IfcSurfaceStyleShading', [rgb, stepReal(1-a)]);
      style = add('IfcSurfaceStyle', [null, '.BOTH.', [shading]]);
      if (ifc2x3) style = add('IfcPresentationStyleAssignment', [[style]]);
      styles.set(key, style);
    }
    add('IfcStyledItem', [item, [style], null]);
  };
  for (const replacement of plan.replacements) {
    const original = entity(replacement.expressId);
    const oldRep = original?.attributes[6];
    if (typeof oldRep !== 'number') throw new Error('Section replacement has no original Representation.');
    oldReps.set(replacement.expressId, oldRep);
    const shapes = entity(oldRep)?.attributes[2];
    const shapeIds = Array.isArray(shapes) ? shapes.filter((id): id is number => typeof id === 'number') : [];
    const representations = shapeIds.map(entity);
    const body = representations.find(shape => String(shape?.attributes[1]).toUpperCase() === 'BODY')
      ?? representations.find(shape => typeof shape?.attributes[0] === 'number');
    const contextId = typeof body?.attributes[0] === 'number' ? body.attributes[0] : context;
    const surfaceModel = ifc2x3 && !replacement.parts.every(part => part.closed);
    const items = replacement.parts.map(part => {
      let item: string;
      if (ifc2x3) {
        const points: string[] = [];
        for (let i = 0; i < part.positions.length; i += 3) points.push(point(part.positions.slice(i, i + 3)));
        const faces: string[] = [];
        for (let i = 0; i < part.indices.length; i += 3) {
          const loop = add('IfcPolyLoop', [part.indices.slice(i, i + 3).map(index => points[index])]);
          const face = add('IfcFace', [[add('IfcFaceOuterBound', [loop, '.T.'])]]);
          faces.push(face);
          if (part.faceColors) styleItem(face, part.faceColors[i/3]);
        }
        const shell = add(part.closed ? 'IfcClosedShell' : 'IfcOpenShell', [faces]);
        item = surfaceModel ? add('IfcShellBasedSurfaceModel', [[shell]]) : add('IfcFacetedBrep', [shell]);
      } else {
        const coords: IfcAttributeValue[] = [];
        const indices: number[][] = [];
        for (let i = 0; i < part.positions.length; i += 3) coords.push(part.positions.slice(i, i + 3).map(stepReal));
        for (let i = 0; i < part.indices.length; i += 3) indices.push(part.indices.slice(i, i + 3).map(index => index + 1));
        const pointList: IfcAttributeValue[] = store.schemaVersion === 'IFC4X3' ? [coords, null] : [coords]; // TagList is IFC4X3-only.
        item = add('IfcTriangulatedFaceSet', [add('IfcCartesianPointList3D', pointList), null, part.closed ? '.T.' : '.F.', indices, null]);
        if (part.faceColors) {
          const palette: IfcAttributeValue[] = [];
          const entries = new Map<string, number>();
          const colorIndices = part.faceColors.map(color => {
            if (Math.abs(color[3]-part.color[3])>1e-6) throw new Error('Section export cannot encode mixed face opacity in one IFC colour map.');
            const key = color.join(',');
            let index = entries.get(key);
            if (index === undefined) { palette.push(color.slice(0,3).map(stepReal)); index=palette.length; entries.set(key,index); }
            return index;
          });
          add('IfcIndexedColourMap', [item, stepReal(part.color[3]), add('IfcColourRgbList', [palette]), colorIndices]);
        }
      }
      styleItem(item, part.color);
      return item;
    });
    const shape = add('IfcShapeRepresentation', [`#${contextId}`, 'Body', ifc2x3 ? (replacement.parts.every(part => part.closed) ? 'Brep' : 'SurfaceModel') : 'Tessellation', items]);
    editor.setPositionalAttribute(replacement.expressId, 6, add('IfcProductDefinitionShape', [null, null, [shape]]));
  }
  // Fills may retain opening metadata after its host cut is baked. Detach the
  // obsolete cutter body too; a live fill reference must not keep it rendered.
  const detachedHosts = new Set(oldReps.keys());
  // @raw-entity-enumeration-ok source void relationships identify bodies superseded by the baked host cut
  for (const id of store.entityIndex.byType.get('IFCRELVOIDSELEMENT') ?? []) {
    const args = entity(id)?.attributes;
    if (typeof args?.[4] !== 'number' || !detachedHosts.has(args[4]) || typeof args[5] !== 'number') continue;
    const opening = args[5], representation = entity(opening)?.attributes[6];
    if (typeof representation === 'number') {
      oldReps.set(opening, representation);
      editor.setPositionalAttribute(opening, 6, null);
    }
  }
  const report: DemeshApplyReport = { replaced: [...oldReps.keys()], skipped: [], warnings: [], prunedEntityCount: 0, strippedOpeningCount: 0 };
  // Retain logical void/fill relationships; detached cutter representations
  // prevent a second subtraction without orphaning IfcOpeningElement records.
  pruneReplacedSubgraphs(store, editor, oldReps, false, report);
  pruneUnusedTypeMaps(store, view, editor, entity, new Set(oldReps.keys()));
  const result = new StepExporter(store, view).export({
    schema: store.schemaVersion ?? 'IFC4', applyMutations: true, visibleOnly: true, hiddenEntityIds: new Set(plan.outside),
  });
  return { content: result.content, trimmed: plan.replacements.map(element => element.expressId), outside: plan.outside };
}

function pruneUnusedTypeMaps(
  store: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  entity: (id: number) => ReturnType<EntityExtractor['extractEntity']>,
  detachedIds: ReadonlySet<number>,
) {
  // Type libraries are templates, not placed bodies. Keep maps only when a
  // surviving original product representation still instantiates them.
  const roots = new Set<number>();
  const typeMaps: Array<{id:number; slot:number; maps:number[]}> = [];
  // @raw-entity-enumeration-ok retained original representations only; detached and tombstoned products are excluded below
  for (const [id, ref] of store.entityIndex.byId) {
    if (view.isDeleted(id)) continue;
    if (PRODUCT_TYPES.has(ref.type.toUpperCase()) && !detachedIds.has(id)) {
      const representation = entity(id)?.attributes[6];
      if (typeof representation === 'number') roots.add(representation);
    }
    const slot = getAttributeNamesForSchema(ref.type, store.schemaVersion).indexOf('RepresentationMaps');
    if (slot >= 0) {
      const maps = entity(id)?.attributes[slot];
      if (Array.isArray(maps)) typeMaps.push({id,slot,maps:maps.filter((map): map is number => typeof map === 'number')});
    }
  }
  // @raw-entity-enumeration-ok walk the same immutable source graph rooted only at retained original representations
  const used = collectReferencedEntityIds(roots, store.source!, store.entityIndex.byId);
  for (const {id,slot,maps} of typeMaps) {
    const retained = maps.filter(map => used.has(map));
    if (retained.length !== maps.length) editor.setPositionalAttribute(id, slot, retained.length ? retained.map(map => `#${map}`) : null);
  }
}

function readPlan(text: string): Plan {
  const value: unknown = JSON.parse(text);
  const ids = (list: unknown): list is number[] => Array.isArray(list) && list.every(id => Number.isSafeInteger(id) && id > 0);
  const numbers = (list: unknown): list is number[] => Array.isArray(list) && list.every(Number.isFinite);
  const rgba = (value: unknown): value is number[] => numbers(value) && value.length === 4 && value.every(c => c >= 0 && c <= 1);
  const part = (p: unknown): p is Part => {
    if (!p || typeof p !== 'object' || !('positions' in p) || !('indices' in p) || !('color' in p) || !('closed' in p) || typeof p.closed !== 'boolean'
      || !numbers(p.positions) || !numbers(p.indices) || !numbers(p.color)) return false;
    return p.positions.length >= 9 && p.positions.length % 3 === 0 && p.indices.length >= 3 && p.indices.length % 3 === 0
      && p.indices.every(i => Number.isSafeInteger(i) && i >= 0 && i < (p.positions as number[]).length / 3)
      && rgba(p.color) && (!('faceColors' in p) || (Array.isArray(p.faceColors)
        && p.faceColors.length === p.indices.length/3 && p.faceColors.every(rgba)));
  };
  if (!value || typeof value !== 'object' || !('outside' in value) || !ids(value.outside)
    || !('replacements' in value) || !Array.isArray(value.replacements)
    || !value.replacements.every((el: unknown) => el && typeof el === 'object' && 'expressId' in el && ids([el.expressId])
      && 'parts' in el && Array.isArray(el.parts) && el.parts.length > 0 && el.parts.every(part))) {
    throw new Error('Invalid canonical section export plan.');
  }
  const plan = value as Plan;
  const allIds = [...plan.outside, ...plan.replacements.map(el => el.expressId)];
  if (new Set(allIds).size !== allIds.length) throw new Error('Duplicate product in section export plan.');
  return plan;
}
