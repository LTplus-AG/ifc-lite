/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a recipient's IFCX export must remove from its node paths (#4444).
 *
 * A recipient reconstructs each room slot from `snapshotToIfcx(doc, { slot })`
 * through the IFCX ingest, which uses a node's path as its GlobalId — so the
 * reconstructed store keys every entity by its ROOM path, `/<slotId>/<GlobalId>`
 * (or `/<GlobalId>` in a room shared before slots existed). That path is what
 * the mirror needs: an outbound edit names the room entity by it, and the
 * inbound apply resolves it by slot. It is not what an exported file should
 * carry: the slot is the room's namespace, not the model's, and two copies of
 * one file exported from a room must read like two exports of that file — the
 * `/<GlobalId>` paths a single-model room has always exported — so either
 * round-trips into a plain viewer and diffs against the other.
 *
 * Only the recipient's reconstructed models are affected. An owner's models
 * are in a room slot too (`collabRoomModels` lists them) but keep their own
 * store: a STEP parse carries bare GlobalIds, an IFCX file its own paths, and
 * neither is namespaced by the slot. The legacy slot has no prefix to strip.
 */

import type { RoomModelTargetState } from './room-model-target';
import { roomModelIdFor } from './model-slot-ref';

/** The slice fields the decision reads. */
export type RoomExportPathState = Pick<RoomModelTargetState, 'collabRoomId' | 'collabRoomModels'>;

/**
 * The prefix `Ifc5Exporter` should remove from `modelId`'s node paths
 * (`stripPathPrefix`), or `undefined` when nothing is to be removed: no live
 * session, not a room model, an owner's own model, or the legacy slot.
 */
export function roomExportPathPrefix(state: RoomExportPathState, modelId: string): string | undefined {
  // Same session gate as `roomSlotFor`: off a session no model is in a room.
  if (state.collabRoomId === null) return undefined;
  const slot = state.collabRoomModels.get(modelId);
  if (!slot || slot.pathPrefix === '') return undefined;
  // The recipient's model of this slot has exactly this id; the owner's model
  // of the same slot is whatever file id the loader minted.
  if (modelId !== roomModelIdFor(state.collabRoomId, slot.slotId)) return undefined;
  return slot.pathPrefix;
}
