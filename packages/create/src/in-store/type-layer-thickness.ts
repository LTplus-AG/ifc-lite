/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A layered type drives its occurrences' thickness (#9296 lane C2).
 *
 * In Revit and Archicad a wall's or slab's thickness is not its own: it is the
 * total of the layered type (composite) it is drawn with. IFC records the same
 * thing as an IfcMaterialLayerSet associated with the type, or with the
 * occurrence through an IfcMaterialLayerSetUsage. This brings the body of each
 * occurrence to the total of its effective layer set after the type
 * relationship or the type's material changes, so typing, retyping and
 * re-layering a type all resize the geometry they describe.
 *
 * The occurrence's own association wins over its type's, as everywhere in
 * IFC, so an occurrence with its own layer set usage keeps that thickness.
 * Geometry that is not a plain extrusion this package can resize (a parsed
 * third-party body, a wall whose openings could not follow) keeps its shape:
 * the type is still assigned, only the resize is skipped.
 */

import { extractMaterialsOnDemand } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { EditTarget } from './edit/target.js';
import { readElementSizeInStore, setElementSizeInStore, type ElementSize } from './element-size-edit.js';
import { readWallMetres } from './wall-size-edit.js';
import { liveEntityConforms, readRelatedLists } from './resolve-relations.js';

/** Thicknesses closer than a micrometre are the same thickness. */
const SAME_THICKNESS_M = 1e-6;

const sizeThickness = (size: ElementSize | null): number | undefined => size?.kind === 'slab' ? size.thickness : undefined;

/** Total thickness in metres of the layer set `entityId` effectively carries, or null when it carries none. */
export function effectiveLayerSetThickness(target: Pick<EditTarget, 'dataStore' | 'view'>, entityId: number): number | null {
  const material = extractMaterialsOnDemand(target.dataStore, entityId, target.view);
  if (material?.type !== 'MaterialLayerSet' || !material.layers?.length) return null;
  let total = 0;
  for (const layer of material.layers) {
    if (typeof layer.thickness !== 'number' || !Number.isFinite(layer.thickness) || layer.thickness < 0) return null;
    total += layer.thickness;
  }
  // The material reader reports layer thicknesses in metres whatever the file's length unit.
  return total > 0 ? total : null;
}

/** Every live occurrence `typeId` types through IfcRelDefinesByType. */
export function typeOccurrencesInStore(target: Pick<EditTarget, 'dataStore' | 'view'>, typeId: number): number[] {
  const out = new Set<number>();
  for (const list of readRelatedLists(target.dataStore, 'IfcRelDefinesByType', target.view)) {
    if (list.relatingId === typeId) for (const id of list.relatedIds) out.add(id);
  }
  return [...out];
}

/**
 * Resize each wall or slab in `objectIds` to the total of its effective layer
 * set. Returns the entities whose geometry changed (for remeshing). The caller
 * owns the outer record, so the relationship edit and the resize undo as one.
 *
 * A resize that refuses (a joined wall whose openings cannot follow) can do so
 * after it has begun writing, so the resizes run in one draft: when every one
 * succeeds that draft commits whole; when one refuses, each occurrence is
 * retried in a draft of its own, so the refused one leaves nothing behind and
 * the others still resize.
 */
export function applyLayerThicknessInStore(target: EditTarget, objectIds: readonly number[]): number[] {
  const plan: Array<{ id: number; kind: 'wall' | 'slab'; thickness: number }> = [];
  for (const id of new Set(objectIds)) {
    const kind = liveEntityConforms(target.dataStore, id, 'IfcWall', target.view) ? 'wall'
      : liveEntityConforms(target.dataStore, id, 'IfcSlab', target.view) ? 'slab' : null;
    if (!kind) continue;
    const thickness = effectiveLayerSetThickness(target, id);
    if (thickness === null) continue;
    // Already that thick (to float noise across unit scales): rewriting would only rebuild the body.
    const current = kind === 'wall' ? readWallMetres(target, id)?.thickness : sizeThickness(readElementSizeInStore(target, id));
    if (current !== undefined && Math.abs(current - thickness) < SAME_THICKNESS_M) continue;
    plan.push({ id, kind, thickness: micrometres(thickness) });
  }
  if (plan.length === 0) return [];
  const resize = (editor: StoreEditor, steps: typeof plan): number[] => {
    const remesh: number[] = [];
    for (const step of steps) {
      const outcome = setElementSizeInStore({ dataStore: target.dataStore, view: editor.getMutationView(), editor }, step.id, { kind: step.kind, thickness: step.thickness });
      if (!outcome.ok) throw new LayerResizeRefused(outcome.reason);
      remesh.push(...outcome.remesh);
    }
    return remesh;
  };
  const attempt = (steps: typeof plan): number[] | null => {
    try {
      return target.editor.runAtomic(draft => resize(draft, steps));
    } catch (error) {
      if (error instanceof LayerResizeRefused) return null;
      throw error;
    }
  };
  const all = attempt(plan);
  if (all) return [...new Set(all)];
  return [...new Set(plan.flatMap(step => attempt([step]) ?? []))];
}

class LayerResizeRefused extends Error {}

/** Snap a float-noisy layer total (0.115 + 0.1 + 0.015) to the micrometre it means. */
function micrometres(metres: number): number {
  return Number(metres.toFixed(6));
}
