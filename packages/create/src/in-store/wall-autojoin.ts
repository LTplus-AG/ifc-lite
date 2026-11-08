/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { AnchorEntityReader } from './resolve-anchor.js';
import { readWallJoinTarget } from './wall-join-read.js';
import { joinWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';

/** End-to-end chains join at coincident endpoints. Crossing/disconnected walls
 * remain explicit joins: proximity alone must never extend an unrelated wall. */
export function autojoinWallInStore(store: IfcDataStore, editor: StoreEditor, wallId: number): string[] {
  const notices: string[] = [];
  let anchor: ReturnType<typeof resolveWallJoinAnchor>;
  try {
    anchor = resolveWallJoinAnchor(store, editor.getMutationView());
  } catch (error) {
    return [`Skipped automatic wall joins for #${wallId}: ${error instanceof Error ? error.message : String(error)}`];
  }
  const reader = new AnchorEntityReader(store, editor.getMutationView());
  for (const type of ['IFCWALL', 'IFCWALLSTANDARDCASE']) for (const otherId of reader.ids(type)) {
    if (otherId === wallId) continue;
    try {
      const a = readWallJoinTarget(store, editor.getMutationView(), wallId, anchor.lengthUnitScale ?? 1);
      const b = readWallJoinTarget(store, editor.getMutationView(), otherId, anchor.lengthUnitScale ?? 1);
      if (!a || !b || a.parentPlacementId !== b.parentPlacementId || Math.abs(a.location[2] - b.location[2]) > 1e-6) continue;
      const ad = [a.wall.end[0] - a.wall.start[0], a.wall.end[1] - a.wall.start[1]];
      const bd = [b.wall.end[0] - b.wall.start[0], b.wall.end[1] - b.wall.start[1]];
      if (Math.abs(ad[0] * bd[1] - ad[1] * bd[0]) < 1e-8) continue;
      if (![a.wall.start, a.wall.end].some(p => [b.wall.start, b.wall.end].some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6))) continue;
      // Each join has its own atomic draft. A refused implicit join must not
      // undo wall creation or any other successful join (#9296 / #9406).
      joinWallsInStore(editor, store, anchor, otherId, wallId);
    } catch (error) {
      notices.push(`Skipped automatic wall join between #${otherId} and #${wallId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return notices;
}
