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
 * the `index`-th shared model gets, and whether a path lies in a slot.
 *
 * Why a copy and not an import: `@ifc-lite/collab` is lazy-loaded inside
 * `startCollab` and code-split into its own chunk so the feature ships dark
 * (see `collabSlice.ts`); `startCollab` has to record the room's slots in
 * the same synchronous `set()` that marks the session live — before that
 * import resolves — and `room-model-target.ts` / `mutation-bridge.ts` run on
 * every edit. A runtime import here would pull yjs into the main bundle.
 * `model-slot-ref.test.ts` pins these two functions against the runtime's
 * own `modelSlotRef` / `pathInSlot`, so the copy cannot drift.
 */

import type { ModelSlotRef } from '@ifc-lite/collab';

/** The slot the `index`-th model of a share gets (`m0`, `m1`, …). */
export function roomSlotRef(index: number): ModelSlotRef {
  const slotId = `m${index}`;
  return { slotId, pathPrefix: `/${slotId}` };
}

/** The implicit single slot of a room shared before slots existed. */
export const LEGACY_ROOM_SLOT: ModelSlotRef = { slotId: 'm0', pathPrefix: '' };

/** Whether a room entity path belongs to `slot` (every path belongs to the legacy slot). */
export function pathInRoomSlot(slot: ModelSlotRef, path: string): boolean {
  if (slot.pathPrefix === '') return true;
  return path.startsWith(`${slot.pathPrefix}/`);
}

/** The viewer model id a recipient registers for one slot of a room. */
export function roomModelIdFor(roomId: string, slotId: string): string {
  return `room:${roomId}:${slotId}`;
}
