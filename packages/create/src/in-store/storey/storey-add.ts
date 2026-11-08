/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Add and rename an IfcBuildingStorey in a parsed model (#9013).
 *
 * The new storey copies its neighbour's conventions: it is aggregated under
 * the same spatial parent (the existing IfcRelAggregates is extended, so the
 * building keeps one decomposition), and its IfcLocalPlacement hangs from the
 * same PlacementRelTo with the same axes, lifted by the elevation difference.
 * Whatever offset the file keeps between Elevation and placement Z (a project
 * base point, a building lift) is therefore preserved.
 */

import { generateIfcGuid, isValidIfcGuid } from '@ifc-lite/encoding';
import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { ownerHistoryRef } from '../_emit-helpers.js';
import { refId } from '../host-geometry-frame.js';
import { assertHostedGlobalIdAvailable } from '../hosted-global-id.js';
import { readStoreyInventory, ref, type StoreyInventory, type StoreyRecord } from './storey-model.js';
import { readPlacementLeaf, worldLiftInParent } from './storey-placement.js';
import { MIN_STOREY_SPACING, StoreyEditRefusedError, describeElevation } from './storey-validation.js';
import { planAttachmentBindings, type StoreyBinding, type WallHeightChange } from './storey-dependents.js';
import { writeTopAttachment } from './storey-attachment.js';
import { writeAttachedTop } from './storey-attached.js';
import { setWallSectionInStore } from '../wall-section-edit.js';
import { scaleWallQuantities, wallGeometry } from './storey-level-write.js';

export interface AddStoreyParams {
  readonly Name: string;
  /** Metres, in the same frame the workspace shows storey elevations. */
  readonly Elevation: number;
  readonly LongName?: string;
  readonly Description?: string;
  readonly GlobalId?: string;
  /** The storey whose conventions the new one copies; defaults to the nearest by elevation. */
  readonly referenceStoreyId?: number;
  /**
   * The IfcBuilding the storey joins. Needed when no `referenceStoreyId` is
   * given and the storeys do not already share one building: a model with
   * several buildings, or with none of its storeys aggregated yet.
   */
  readonly buildingId?: number;
}

export interface AddStoreyResult {
  readonly storeyId: number;
  readonly placementId: number;
  readonly relAggregatesId: number;
  /** Elements that the new storey binds but cannot resize (their body or placement is unreadable). */
  readonly unresizedWalls: readonly number[];
  /** Walls now bound to this storey and resized to reach it. */
  readonly boundWalls: readonly WallHeightChange[];
  /**
   * Every element now bound to this storey (walls included): drawn attached
   * with no storey above, or relatively bound to the storey above theirs and
   * re-bound because this one was inserted between (#9296).
   */
  readonly bindings: readonly StoreyBinding[];
  /** Products whose shape changed (the bound elements, their openings and parts). */
  readonly reshaped: readonly number[];
}

const OP = 'addStoreyInStore';

/**
 * Why `params` cannot be added, or null. Shared by the UI's inline validation.
 * Only storeys of the building the new storey joins (`parentId`, when known)
 * can clash: another building may well have a storey at the same elevation.
 */
export function addStoreyRefusal(
  inventory: StoreyInventory, params: Pick<AddStoreyParams, 'Name' | 'Elevation'>, parentId?: number | null,
): string | null {
  if (!params.Name.trim()) return 'A storey needs a name';
  if (!Number.isFinite(params.Elevation)) return 'Enter an elevation in metres';
  const clash = inventory.storeys.find((storey) => (parentId === undefined || storey.parentId === parentId)
    && Math.abs(storey.elevation - params.Elevation) < MIN_STOREY_SPACING);
  if (clash) return `${clash.Name} is already at ${describeElevation(clash.elevation)}: storeys need a positive floor-to-floor height`;
  return null;
}

function nearest(inventory: StoreyInventory, elevation: number, parentId: number): StoreyRecord | null {
  let best: StoreyRecord | null = null;
  for (const storey of inventory.storeys) {
    if (storey.parentId !== parentId) continue;
    if (!best || Math.abs(storey.elevation - elevation) < Math.abs(best.elevation - elevation)) best = storey;
  }
  return best;
}

/** The building the new storey joins, refusing a reference and a `buildingId` that disagree. */
function joinedBuilding(inventory: StoreyInventory, params: AddStoreyParams): { parentId: number; requested: StoreyRecord | null } {
  if (params.referenceStoreyId === undefined) {
    const parents = [...new Set(inventory.storeys.map((storey) => storey.parentId))];
    const shared = params.buildingId === undefined && parents.length === 1 ? parents[0] : null;
    return { parentId: shared ?? soleBuilding(inventory, params.buildingId), requested: null };
  }
  const requested = inventory.storeys.find((storey) => storey.expressId === params.referenceStoreyId);
  if (!requested) throw new Error(`${OP}: #${params.referenceStoreyId} is not a live IfcBuildingStorey`);
  // The new storey copies the reference's PlacementRelTo, so it must join the
  // reference's building too; a reference outside any building has none to give.
  // Any spatial parent is kept as the file has it: storeys aggregated under a
  // site or straight under the project exist, and the new one joins them there.
  if (requested.parentId === null) {
    throw new Error(`${OP}: ${requested.Name} is not aggregated under a building, so a new storey cannot follow it; choose another reference storey`);
  }
  if (params.buildingId !== undefined && params.buildingId !== requested.parentId) {
    throw new Error(`${OP}: ${requested.Name} belongs to #${requested.parentId}, not building #${params.buildingId}; choose a reference storey in that building`);
  }
  return { parentId: requested.parentId, requested };
}

function soleBuilding(inventory: StoreyInventory, requested: number | undefined): number {
  const buildings = [...inventory.reader.ids('IFCBUILDING')];
  if (requested !== undefined) {
    if (!buildings.includes(requested)) throw new Error(`${OP}: #${requested} is not a live IfcBuilding`);
    return requested;
  }
  if (buildings.length !== 1) throw new Error(`${OP}: the model has ${buildings.length} buildings; choose the one the storey belongs to`);
  return buildings[0];
}

/** What adding a storey would do, before anything is written. */
export interface StoreyAddPlan {
  /** Why the storey cannot be added, or null. */
  readonly refusal: string | null;
  /** Elements the new storey would bind or re-bind (#9296), with the heights they would take. */
  readonly bindings: readonly StoreyBinding[];
  /** Elements it would bind but could not resize. */
  readonly unresized: readonly number[];
}

/**
 * Dry run of `addStoreyInStore`: its refusal and the attachments it would
 * (re-)bind. The complete add is written into a draft that is never
 * published, so a late refusal (a re-bound element left no height, an
 * opening above a wall's new top) is reported here exactly as the add would
 * refuse it. Writes nothing.
 */
export function planStoreyAdd(inventory: StoreyInventory, params: AddStoreyParams): StoreyAddPlan {
  const refused = (error: unknown): StoreyAddPlan => ({
    refusal: error instanceof Error ? error.message.replace(`${OP}: `, '') : String(error), bindings: [], unresized: [],
  });
  let planned: ReturnType<typeof planAttachmentBindings>;
  try {
    const { parentId } = joinedBuilding(inventory, params);
    const refusal = addStoreyRefusal(inventory, params, parentId);
    if (refusal) return { refusal, bindings: [], unresized: [] };
    planned = planAttachmentBindings(inventory, params.Elevation, parentId);
  } catch (error) {
    return refused(error);
  }
  try {
    inventory.view.prepareAtomic((draft) => addStoreyInStore(inventory.store, new StoreEditor(inventory.store, draft), params)).rollback();
  } catch (error) {
    return refused(error);
  }
  return { refusal: null, bindings: planned.bindings, unresized: planned.unreadable };
}

/** Add a storey atomically. Throws (writing nothing) when the storey cannot be placed. */
export function addStoreyInStore(store: IfcDataStore, editor: StoreEditor, params: AddStoreyParams): AddStoreyResult {
  return editor.runAtomic((draft) => {
    const inventory = readStoreyInventory(store, draft.getMutationView());
    if (params.GlobalId !== undefined) {
      if (!isValidIfcGuid(params.GlobalId)) throw new Error(`${OP}: GlobalId "${params.GlobalId}" is not a valid IFC GUID`);
      // Every live IfcRoot owner, relationships included (the table index omits their GUIDs).
      assertHostedGlobalIdAvailable(store, draft.getMutationView(), params.GlobalId);
    }
    const ownerHistoryId = inventory.reader.firstId('IFCOWNERHISTORY');
    if (inventory.schema === 'IFC2X3' && ownerHistoryId === null) throw new Error(`${OP}: IFC2X3 requires IfcOwnerHistory`);

    // The building first: a reference storey names it; otherwise the one
    // building the storeys share, or the sole IfcBuilding (or `buildingId`).
    const { parentId, requested } = joinedBuilding(inventory, params);
    const refusal = addStoreyRefusal(inventory, params, parentId);
    if (refusal) throw new Error(refusal);
    const reference = requested ?? nearest(inventory, params.Elevation, parentId);
    const placementId = emitStoreyPlacement(draft, inventory, reference, parentId, params.Elevation);
    const elevationAttribute = reference?.elevationAttribute !== null && reference?.elevationAttribute !== undefined
      ? reference.elevationAttribute + (params.Elevation - reference.elevation) / inventory.scale
      : params.Elevation / inventory.scale;

    const storeyId = draft.addEntity('IfcBuildingStorey', [
      params.GlobalId ?? generateIfcGuid(),
      ownerHistoryRef(ownerHistoryId),
      params.Name.trim(),
      params.Description ?? null,
      null,
      ref(placementId),
      null,
      params.LongName ?? null,
      '.ELEMENT.',
      { real: roundNative(elevationAttribute) },
    ]).expressId;

    const relAggregatesId = aggregateUnder(draft, inventory, parentId, storeyId, ownerHistoryId, reference?.aggregateRelId ?? null);
    const guid = String(draft.getNewEntity(storeyId)?.attributes[0]);
    const bindings = planAttachmentBindings(inventory, params.Elevation, parentId);
    const boundWalls = bindings.walls.map((wall) => ({ ...wall, targetStoreyId: storeyId }));
    const view = draft.getMutationView();
    for (const id of bindings.unreadable) writeTopAttachment(view, id, guid, 'relative');
    const reshaped: number[] = [];
    const target = { dataStore: store, view, editor: draft };
    for (const binding of bindings.bindings) {
      writeTopAttachment(view, binding.elementId, guid, 'relative');
      if (Math.abs(binding.to - binding.from) < 1e-9) continue;
      const refuse = (reason: string) => new StoreyEditRefusedError([{
        code: 'dependent', elementIds: [binding.elementId],
        message: `#${binding.elementId} is attached to the storey above but cannot reach the new storey: ${reason}`,
      }]);
      if (binding.to < 0.01 && binding.kind !== 'linear') throw refuse(`it would end ${binding.to.toFixed(3)} m tall`);
      const geometry = binding.kind === 'wall' ? wallGeometry(store, view, draft, binding.elementId) : undefined;
      const outcome = binding.kind === 'wall'
        ? setWallSectionInStore(target, binding.elementId, { height: binding.to })
        : writeAttachedTop(target, binding.elementId, binding.kind, binding.from, binding.to);
      if (!outcome.ok) throw refuse(outcome.reason);
      // The same quantity upkeep as a re-level: Height, areas and volumes follow the new height.
      if (binding.kind === 'wall') scaleWallQuantities(store, view, binding.elementId, binding.to / binding.from, geometry);
      reshaped.push(...outcome.remesh);
    }
    return { storeyId, placementId, relAggregatesId, boundWalls, bindings: bindings.bindings, unresizedWalls: bindings.unreadable, reshaped: [...new Set(reshaped)] };
  });
}

/** Rename a storey. Throws for an empty name or a dead storey. */
export function renameStoreyInStore(store: IfcDataStore, editor: StoreEditor, storeyId: number, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A storey needs a name');
  editor.runAtomic((draft) => {
    const inventory = readStoreyInventory(store, draft.getMutationView());
    if (!inventory.storeys.some((storey) => storey.expressId === storeyId)) throw new Error(`#${storeyId} is not a live IfcBuildingStorey in this model`);
    draft.setAttribute(storeyId, 'Name', trimmed);
  });
}

/** Avoid 2.9999999999999996 in the written file; 1e-9 file units is far below any modelling tolerance. */
function roundNative(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function emitStoreyPlacement(
  draft: StoreEditor, inventory: StoreyInventory, reference: StoreyRecord | null, parentId: number, elevation: number,
): number {
  const leaf = reference?.placementId != null ? readPlacementLeaf(inventory.reader, reference.placementId) : null;
  // A neighbour whose placement cannot be read must not be replaced by a
  // default: the new storey would silently lose its axes and offset.
  if (reference?.placementId != null && !leaf) throw new Error(`${OP}: the placement of ${reference.Name} cannot be read, so the new storey cannot follow it`);
  if (reference && leaf) {
    const lift = worldLiftInParent(inventory.reader, leaf.parentId, (elevation - reference.elevation) / inventory.scale);
    if (!lift) throw new Error(`${OP}: the placement of ${reference.Name} cannot be read`);
    const point = draft.addEntity('IfcCartesianPoint', [[0, 1, 2].map((i) => roundNative(leaf.location[i] + lift[i]))]).expressId;
    const axis = draft.addEntity('IfcAxis2Placement3D', [ref(point), directionRef(leaf.axis), directionRef(leaf.refDirection)]).expressId;
    return draft.addEntity('IfcLocalPlacement', [leaf.parentId === null ? null : ref(leaf.parentId), ref(axis)]).expressId;
  }
  // No neighbour placement to copy: hang from the parent's own placement, as
  // IfcCreator does, lifted along WORLD +Z however that placement is turned.
  const parent = inventory.reader.entity(parentId);
  const parentPlacement = parent ? refId(parent.attributes[5]) : null;
  const lift = worldLiftInParent(inventory.reader, parentPlacement, elevation / inventory.scale);
  if (!lift) throw new Error(`${OP}: the placement of building #${parentId} cannot be read, so the new storey cannot be placed in it`);
  const point = draft.addEntity('IfcCartesianPoint', [lift.map((v) => roundNative(v) + 0)]).expressId;
  const axis = draft.addEntity('IfcAxis2Placement3D', [ref(point), null, null]).expressId;
  return draft.addEntity('IfcLocalPlacement', [parentPlacement === null ? null : ref(parentPlacement), ref(axis)]).expressId;
}

function directionRef(value: unknown): string | null {
  const id = refId(value);
  return id === null ? null : ref(id);
}

/** Extend the parent's existing decomposition, or start one. */
function aggregateUnder(
  draft: StoreEditor, inventory: StoreyInventory, parentId: number, storeyId: number,
  ownerHistoryId: number | null, preferredRelId: number | null,
): number {
  const view: MutablePropertyView = draft.getMutationView();
  const existing = (inventory.outgoing.get(parentId) ?? []).filter((rel) => rel.type === 'IFCRELAGGREGATES');
  const rel = existing.find((candidate) => candidate.id === preferredRelId) ?? existing[0];
  if (rel && !view.isDeleted(rel.id)) {
    draft.setPositionalAttribute(rel.id, rel.listIndex, [...rel.children.map(ref), ref(storeyId)]);
    return rel.id;
  }
  return draft.addEntity('IfcRelAggregates', [
    generateIfcGuid(), ownerHistoryRef(ownerHistoryId), null, null, ref(parentId), [ref(storeyId)],
  ]).expressId;
}
