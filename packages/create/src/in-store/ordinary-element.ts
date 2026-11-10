/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { toNativeLength, type SpatialAnchor } from './anchor.js';
import { applyNewElementTop, type TopConstraint } from './storey/storey-top-constraint.js';
import { addBeamToStore, type BeamInStoreParams, type ProfiledBeamInStoreParams } from './beam.js';
import { addColumnToStore, type ColumnInStoreParams, type ProfiledColumnInStoreParams } from './column.js';
import { addMemberToStore, type MemberInStoreParams, type ProfiledMemberInStoreParams } from './member.js';
import { addPlateToStore, type PlateInStoreParams } from './plate.js';
import { addRoofToStore, type RoofInStoreParams } from './roof.js';
import { addSlabToStore, type SlabInStoreParams } from './slab.js';
import { addSpaceToStore, type SpaceInStoreParams } from './space.js';
import { autojoinWallInStore } from './wall-autojoin.js';
import { withWallAutojoinIndex, type WallAutojoinIndex } from './wall-autojoin-index.js';
import { addWallToStore, type WallInStoreParams } from './wall.js';

/** The eight ordinary builders shared by loaded-model gestures and SDK/MCP.
 * Parameters retain their existing storey-local metre and profile contracts. */
export type OrdinaryInStoreElement =
  | { kind: 'column'; params: ColumnInStoreParams | ProfiledColumnInStoreParams }
  | { kind: 'wall'; params: WallInStoreParams }
  | { kind: 'slab'; params: SlabInStoreParams }
  | { kind: 'beam'; params: BeamInStoreParams | ProfiledBeamInStoreParams }
  | { kind: 'space'; params: SpaceInStoreParams }
  | { kind: 'roof'; params: RoofInStoreParams }
  | { kind: 'plate'; params: PlateInStoreParams }
  | { kind: 'member'; params: MemberInStoreParams | ProfiledMemberInStoreParams };

/** Commit one existing builder atomically (#6232 D5). A late refusal leaves
 * no placement/profile/representation helpers or journal entries behind.
 * The caller supplies a resolved anchor or resolves it using this transaction's
 * draft. The latter includes existing UI placement preparation in this same
 * transaction, without changing its policy or nesting another atomic edit.
 * Renderer, room and history effects remain with the caller after success. */
export function addOrdinaryElementInStore(
  editor: StoreEditor,
  anchor: SpatialAnchor | ((draft: StoreEditor) => SpatialAnchor),
  element: OrdinaryInStoreElement,
  /**
   * The new element's top constraint (#9296), applied in the same
   * transaction to a wall, column, beam or member (`applyNewElementTop`).
   */
  options: {
    readonly top?: TopConstraint | 'auto'; readonly store?: IfcDataStore;
    /** Receives skipped implicit-join notices after creation commits. */
    readonly notices?: string[];
    /** Owning host transaction's staged endpoint index. */
    readonly wallIndex?: WallAutojoinIndex;
  } = {},
): number {
  if (element.kind === 'wall' && options.store && !options.wallIndex) {
    return withWallAutojoinIndex(options.store, editor.getMutationView(), wallIndex =>
      addOrdinaryElementInStore(editor, anchor, element, { ...options, wallIndex }));
  }
  const notices: string[] = [];
  const id = editor.runAtomic(draft => {
    const resolved = typeof anchor === 'function' ? anchor(draft) : anchor;
    const id = emitOrdinaryElement(draft, resolved, element);
    if (options.top !== undefined && options.store && TOP_KINDS.has(element.kind)) applyNewElementTop(options.store, draft, id, options.top, resolved.storeyId);
    if (element.kind === 'wall' && options.store && options.wallIndex) {
      try {
        notices.push(...autojoinWallInStore(options.store, draft, {
          wallId: id, parentPlacementId: resolved.storeyPlacementId,
          elevation: toNativeLength(resolved, element.params.Start[2]),
          start: [element.params.Start[0], element.params.Start[1]], end: [element.params.End[0], element.params.End[1]],
        }, options.wallIndex, resolved));
      } catch (error) {
        notices.push(`Skipped automatic wall joins for #${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return id;
  });
  if (options.notices) options.notices.push(...notices);
  else for (const notice of notices) console.warn(`[ifc-lite/create] ${notice}`);
  return id;
}

const TOP_KINDS = new Set<OrdinaryInStoreElement['kind']>(['wall', 'column', 'beam', 'member']);

/** Package-private builder dispatch; callers own the enclosing atomic edit. */
export function emitOrdinaryElement(draft: StoreEditor, resolved: SpatialAnchor, element: OrdinaryInStoreElement): number {
  switch (element.kind) {
    case 'column': return addColumnToStore(draft, resolved, element.params).columnId;
    case 'wall': return addWallToStore(draft, resolved, element.params).wallId;
    case 'slab': return addSlabToStore(draft, resolved, element.params).slabId;
    case 'beam': return addBeamToStore(draft, resolved, element.params).beamId;
    case 'space': return addSpaceToStore(draft, resolved, element.params).spaceId;
    case 'roof': return addRoofToStore(draft, resolved, element.params).roofId;
    case 'plate': return addPlateToStore(draft, resolved, element.params).plateId;
    case 'member': return addMemberToStore(draft, resolved, element.params).memberId;
    default: throw new Error('addOrdinaryElementInStore: unsupported element kind');
  }
}
