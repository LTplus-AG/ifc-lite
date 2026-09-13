/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Room model slots, viewer side (#4444).
 *
 * The room keys every entity by slot-qualified path (`/<slotId>/<GlobalId>`,
 * or the unqualified `/<GlobalId>` of a room shared before slots existed) —
 * see `packages/collab/src/doc/model-slot.ts`, which owns the scheme. This
 * module is the viewer's copy of the two rules the store and its eagerly
 * loaded collab helpers need BEFORE the collab runtime is loaded: which slot
 * the `index`-th shared model gets, the path of a GlobalId in a slot, and
 * whether a path lies in a slot. Every viewer site that builds or tests a
 * slot path goes through THIS module, never through `pathPrefix` by hand, so
 * the owner's outbound path and the recipient's inbound path cannot drift.
 *
 * Why a copy and not an import: `@ifc-lite/collab` is lazy-loaded inside
 * `startCollab` and code-split into its own chunk so the feature ships dark
 * (see `collabSlice.ts`); `startCollab` has to record the room's slots in
 * the same synchronous `set()` that marks the session live — before that
 * import resolves — and `room-model-target.ts` / `mutation-bridge.ts` run on
 * every edit. A runtime import here would pull yjs into the main bundle.
 * `model-slot-ref.test.ts` pins these functions against the runtime's own
 * `modelSlotRef` / `slotPath` / `pathInSlot`, so the copy cannot drift.
 */

import type { ModelSlotRef } from '@ifc-lite/collab';

/** The slot the `index`-th model of a share gets (`m0`, `m1`, …). */
export function roomSlotRef(index: number): ModelSlotRef {
  const slotId = `m${index}`;
  return { slotId, pathPrefix: `/${slotId}` };
}

/** The implicit single slot of a room shared before slots existed. */
export const LEGACY_ROOM_SLOT: ModelSlotRef = { slotId: 'm0', pathPrefix: '' };

/** The room path of a GlobalId-keyed (STEP) entity in `slot` (runtime: `slotPath`). */
export function roomSlotPath(slot: ModelSlotRef, guid: string): string {
  return `${slot.pathPrefix}/${guid}`;
}

/** Whether a room entity path belongs to `slot` (every path belongs to the legacy slot). */
export function pathInRoomSlot(slot: ModelSlotRef, path: string): boolean {
  if (slot.pathPrefix === '') return true;
  return path.startsWith(`${slot.pathPrefix}/`);
}

/** The viewer model id a recipient registers for one slot of a room. */
export function roomModelIdFor(roomId: string, slotId: string): string {
  return `room:${roomId}:${slotId}`;
}

/**
 * The display name a recipient gives the model of one slot: the owner's name,
 * suffixed by position when another slot carries the same one — the issue's
 * own reproduction (two copies of one file) would otherwise register two
 * identically named entries in the hierarchy and the Export dialog. Recipient
 * side only; the slot record keeps the owner's name verbatim.
 */
export function roomModelNameFor(slots: ReadonlyArray<{ slotId: string; name: string }>, slotId: string): string {
  const own = slots.find((s) => s.slotId === slotId);
  if (!own) return slotId;
  const sameName = slots.filter((s) => s.name === own.name);
  const position = sameName.findIndex((s) => s.slotId === slotId);
  return sameName.length > 1 && position > 0 ? `${own.name} (${position + 1})` : own.name;
}
