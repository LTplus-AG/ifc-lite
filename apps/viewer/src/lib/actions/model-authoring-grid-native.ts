/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { addGridToStore, addColumnOnGridToStore, extractGridAxesForStorey, resolveSpatialAnchor } from '@ifc-lite/create';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { applyFrame, placementRelativeTo, refId } from '../../../../../packages/create/src/in-store/host-geometry-frame.js';
import { readAxisEnds } from '../../../../../packages/create/src/in-store/extract-grids.js';
import { ensureStoreyPlacement } from '@/store/slices/storeyPlacement';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
import type { ModelAuthoringBatch } from './model-authoring';
import type { ReviewedGridOp, GridExpected } from './model-authoring-grid-fields';
import { gridParamsInMetres, gridColumnParamsInMetres } from './model-authoring-grid-fields';
import { uniqueSplitGuid } from './model-authoring-split';
import { MAX_GRID_AXES } from '@/lib/commands/modeling/commands/grid-place-geometry';
import type { ElementId } from './model-authoring-native';

/** Native source and effective membership must prove the entire selected grid, not merely readable neighbours. */
export function nativeGridExpected(target: ModelEditTarget | null, gridId: number, storeyId: number): GridExpected | null {
  if (!target || !nativeLengthUnitAvailable(target) || !target.dataStore.source?.byteLength) return null;
  const read = new AnchorEntityReader(target.dataStore, target.view), grid = read.entity(gridId);
  if (grid?.type.toUpperCase() !== 'IFCGRID') return null;
  const ids: number[] = [];
  for (const index of [7, 8, 9]) {
    const raw = grid.attributes[index];
    if (raw === null || raw === undefined) continue;
    if (!Array.isArray(raw) || raw.length + ids.length > MAX_GRID_AXES) return null;
    for (const ref of raw) { const id = refId(ref); if (id === null) return null; ids.push(id); }
  }
  if (ids.length < 2 || new Set(ids).size !== ids.length) return null;
  const native = extractGridAxesForStorey(target.dataStore, storeyId, target.view);
  const rows = native.axes.filter(axis => axis.gridId === gridId);
  if (!native.gridIds.includes(gridId) || rows.length !== ids.length || rows.some(axis => !ids.includes(axis.axisId) || axis.AxisTag.length > 200)) return null;
  const axes = rows.map(axis => ({ expressId: axis.axisId, AxisTag: axis.AxisTag, family: axis.family, a: [...axis.a] as [number, number], b: [...axis.b] as [number, number] }));
  const placementId = refId(grid.attributes[5]);
  const storeyPlacementId = refId(read.entity(storeyId)?.attributes[5]);
  if (placementId === null || storeyPlacementId === null) return null;
  const relative = placementRelativeTo(read, placementId, storeyPlacementId);
  if (!relative) return null;
  const scale = getModelLengthUnitScale(target.dataStore);
  // The existing native snap extractor's placement reader is positional. Do
  // not certify saved coordinates when a named current placement differs.
  // Compare using its shared axis reader and the canonical current frame;
  // refusal leaves the native producer authoritative, without a frame fork.
  for (const axis of rows) {
    const curveId = refId(read.entity(axis.axisId)?.attributes[1]);
    const ends = curveId === null ? null : readAxisEnds(id => read.entity(id), curveId);
    if (!ends) return null;
    for (const [index, actual] of [axis.a, axis.b].entries()) {
      const point = applyFrame(relative, [ends[index][0], ends[index][1], 0]);
      if (actual.some((value, component) => Math.abs(value - point[component] * scale) > 1e-8)) return null;
    }
  }
  const frame = { ...relative, o: relative.o.map(v => v * scale) as [number, number, number] };
  return { axes, frame };
}
export function sameGridExpected(a: GridExpected | null, b: GridExpected): boolean {
  return !!a && (['o', 'x', 'y', 'z'] as const).every(key => a.frame[key].every((v, i) => Math.abs(v - b.frame[key][i]) <= 1e-8)) && a.axes.length === b.axes.length && a.axes.every((row, index) => {
    const other = b.axes[index];
    return row.expressId === other.expressId && row.AxisTag === other.AxisTag && row.family === other.family
      && [...row.a, ...row.b].every((v, i) => Math.abs(v - [...other.a, ...other.b][i]) <= 1e-8);
  });
}
/** Resolve tag selectors only against the actual earlier native grid's current axis records. */
export function gridBindingForDraft(store: IfcDataStore, draft: StoreEditor, op: Extract<ReviewedGridOp, { op: 'column.createOnGrid' }>, grid: ElementId, refs: ReadonlyMap<string, number>, storeyId: number) {
  const GridId = 'id' in grid ? grid.id : refs.get(grid.ref);
  if (GridId === undefined) throw new Error('The approved native grid has not been created');
  if ('target' in op.grid) {
    const view = draft.getMutationView();
    const root = new AnchorEntityReader(store, view).entity(GridId);
    if (!uniqueSplitGuid(store, draft, op.grid.target.globalId) || root?.attributes[0] !== op.grid.target.globalId || (root.attributes[2] ?? '') !== op.grid.target.name
      || !sameGridExpected(nativeGridExpected({ modelId: op.grid.target.modelId ?? '', dataStore: store, view, editor: draft }, GridId, storeyId), op.grid.expected)) throw new Error('The current native grid identity, axes or placement changed before writing');
    return { GridId, IntersectingAxes: op.grid.IntersectingAxes };
  }
  const reader = new AnchorEntityReader(store, draft.getMutationView()), root = reader.entity(GridId);
  if (root?.type.toUpperCase() !== 'IFCGRID') throw new Error('The earlier creation is not a current native grid');
  const ids = [7, 8, 9].flatMap(index => Array.isArray(root.attributes[index]) ? root.attributes[index] : []).map(refId).filter((id): id is number => id !== null);
  if (ids.length > MAX_GRID_AXES) throw new Error('The native grid exceeds the reviewed axis bound');
  const IntersectingAxes = op.grid.IntersectingAxes.map(tag => {
    const hits = ids.filter(id => reader.entity(id)?.attributes[0] === tag);
    if (hits.length !== 1) throw new Error('The current native axis tag is missing or ambiguous');
    return hits[0];
  }) as [number, number];
  return { GridId, IntersectingAxes };
}
export function writeGridCreation(store: IfcDataStore, draft: StoreEditor, batch: ModelAuthoringBatch, op: ReviewedGridOp, storey: number, grid: ElementId | undefined, refs: ReadonlyMap<string, number>): number {
  ensureStoreyPlacement(store, draft, storey);
  const anchor = resolveSpatialAnchor(store, storey, draft.getMutationView());
  if (op.op === 'grid.create') return addGridToStore(draft, anchor, gridParamsInMetres(op.params, batch.units)).gridId;
  if (!grid) throw new Error('The bound column has no resolved native grid');
  return addColumnOnGridToStore(draft, store, anchor, gridColumnParamsInMetres(op.params, batch.units), gridBindingForDraft(store, draft, op, grid, refs, storey)).columnId;
}
