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
 * the type is still assigned, only the resize is skipped, and the skip is
 * reported per element (`takeLayerThicknessOutcome`) so no caller has to
 * leave it silent.
 *
 * One edit, one building: a resized wall re-trims the walls joined to it, and
 * the generated rooms it bounds take their new outline and quantities in the
 * same record, so the outcome's remesh list names every element whose body
 * changed, not only the occurrences.
 */

import { extractMaterialsOnDemand } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { EditTarget } from './edit/target.js';
import { readElementSizeInStore, setElementSizeInStore, type ElementSize } from './element-size-edit.js';
import { readWallMetres } from './wall-size-edit.js';
import { liveEntityConforms, readRelatedLists } from './resolve-relations.js';
import { effectiveStoreyId } from './edit/effective-storey.js';
import { prepareGeneratedRoomUpdate } from './generated-room-update.js';

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

/** What one layer-driven resize did, per element (#9296 lane U3). */
export interface LayerThicknessOutcome {
  /** Every element whose body changed: the resized occurrences, the walls joined to them, their openings and the generated rooms they bound. */
  readonly remesh: readonly number[];
  /** Occurrences now as thick as their effective layer set. */
  readonly resized: readonly number[];
  /** Occurrences whose body could not follow; each keeps its previous shape. */
  readonly refused: readonly { readonly id: number; readonly reason: string }[];
  /** Rooms that could not follow, in plain language. */
  readonly notices: readonly string[];
}

const EMPTY: LayerThicknessOutcome = { remesh: [], resized: [], refused: [], notices: [] };
const outcomes = new WeakMap<StoreEditor, LayerThicknessOutcome>();

/**
 * The resizes `applyLayerThicknessInStore` made through `editor` since the last
 * take, merged, and forgotten. A typing or layer edit made through the modelling
 * backend resizes inside it; the caller that owns the record takes the outcome
 * afterwards to remesh every changed element and to report each refusal.
 */
export function takeLayerThicknessOutcome(editor: StoreEditor): LayerThicknessOutcome {
  const outcome = outcomes.get(editor) ?? EMPTY;
  outcomes.delete(editor);
  return outcome;
}

function remember(editor: StoreEditor, next: LayerThicknessOutcome): void {
  const prior = outcomes.get(editor) ?? EMPTY;
  outcomes.set(editor, {
    remesh: [...new Set([...prior.remesh, ...next.remesh])],
    resized: [...new Set([...prior.resized, ...next.resized])],
    refused: [...prior.refused.filter(r => !next.resized.includes(r.id)), ...next.refused],
    notices: [...prior.notices, ...next.notices],
  });
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
 * the others still resize. Generated rooms bounded by a resized wall follow it.
 */
export function applyLayerThicknessInStore(target: EditTarget, objectIds: readonly number[]): number[] {
  const plan: LayerResizeStep[] = [];
  for (const id of new Set(objectIds)) {
    const kind = layeredKind(target, id);
    if (!kind) continue;
    const thickness = effectiveLayerSetThickness(target, id);
    if (thickness === null) continue;
    const step = resizeStep(target, id, kind, thickness);
    if (step) plan.push(step);
  }
  if (plan.length === 0) return [];
  const outcome = resizeLayeredInStore(target, plan);
  remember(target.editor, outcome);
  return [...outcome.remesh];
}

/** One planned resize: an occurrence and the total it takes. */
export interface LayerResizeStep { readonly id: number; readonly kind: 'wall' | 'slab'; readonly thickness: number }

/** Whether `id` is an occurrence a layer set sizes: a wall (across) or a slab (through). */
export function layeredKind(target: Pick<EditTarget, 'dataStore' | 'view'>, id: number): 'wall' | 'slab' | null {
  return liveEntityConforms(target.dataStore, id, 'IfcWall', target.view) ? 'wall'
    : liveEntityConforms(target.dataStore, id, 'IfcSlab', target.view) ? 'slab' : null;
}

/** The body thickness of a wall or slab in metres, when it reads as one. */
export function bodyThickness(target: EditTarget, id: number, kind: 'wall' | 'slab'): number | undefined {
  return kind === 'wall' ? readWallMetres(target, id)?.thickness : sizeThickness(readElementSizeInStore(target, id));
}

/** The step that brings `id` to `thickness`, or null when it already is that thick (to float noise across unit scales). */
export function resizeStep(target: EditTarget, id: number, kind: 'wall' | 'slab', thickness: number): LayerResizeStep | null {
  const current = bodyThickness(target, id, kind);
  if (current !== undefined && Math.abs(current - thickness) < SAME_THICKNESS_M) return null;
  return { id, kind, thickness: micrometres(thickness) };
}

/**
 * Run `plan` on `target.editor`: the resizes, then the generated rooms the
 * resized walls bound. The one write path behind both an applied layer edit
 * and its preview (`previewTypeLayerImpact`), so the two cannot differ.
 */
export function resizeLayeredInStore(target: EditTarget, plan: readonly LayerResizeStep[]): LayerThicknessOutcome {
  if (plan.length === 0) return EMPTY;
  const notices: string[] = [];
  const updateRooms = prepareRooms(target, plan.filter(step => step.kind === 'wall').map(step => step.id), notices);
  const refused: Array<{ id: number; reason: string }> = [];
  const resize = (editor: StoreEditor, steps: readonly LayerResizeStep[]): number[] => {
    const remesh: number[] = [];
    for (const step of steps) {
      const outcome = setElementSizeInStore({ dataStore: target.dataStore, view: editor.getMutationView(), editor }, step.id, { kind: step.kind, thickness: step.thickness });
      if (!outcome.ok) throw new LayerResizeRefused(step.id, outcome.reason);
      remesh.push(...outcome.remesh);
    }
    return remesh;
  };
  const attempt = (steps: readonly LayerResizeStep[]): number[] | null => {
    try {
      return target.editor.runAtomic(draft => resize(draft, steps));
    } catch (error) {
      if (!(error instanceof LayerResizeRefused)) throw error;
      if (steps.length === 1) refused.push({ id: error.id, reason: error.message });
      return null;
    }
  };
  const all = attempt(plan);
  const sized: LayerResizeStep[] = all ? [...plan] : [];
  const changed = all ?? [];
  if (!all) {
    for (const step of plan) {
      const alone = attempt([step]);
      if (alone) { sized.push(step); changed.push(...alone); }
    }
  }
  const remesh = [...new Set([...changed, ...(sized.length > 0 ? updateRooms() : [])])];
  return { remesh, resized: sized.map(step => step.id), refused, notices };
}

/** Ready the generated rooms on the walls' storeys to follow them (read before any wall changes). */
function prepareRooms(target: EditTarget, wallIds: readonly number[], notices: string[]): () => number[] {
  const storeys = [...new Set(wallIds.map(id => effectiveStoreyId(target.dataStore, target.view, id)))]
    .filter((id): id is number => id !== undefined);
  try {
    return prepareGeneratedRoomUpdate(target.dataStore, target.editor, storeys, notices);
  } catch (error) {
    notices.push(`Generated rooms could not follow the new wall thickness (${error instanceof Error ? error.message : String(error)}); their outlines and quantities are unchanged.`);
    return () => [];
  }
}

class LayerResizeRefused extends Error {
  constructor(readonly id: number, reason: string) { super(reason); }
}

/** Snap a float-noisy layer total (0.115 + 0.1 + 0.015) to the micrometre it means. */
function micrometres(metres: number): number {
  return Number(metres.toFixed(6));
}
