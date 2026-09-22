/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one tombstone guard every inbound collab write passes through (#5187).
 *
 * A peer's write to an entity the local user has deleted must be REFUSED, not
 * recorded: `MutablePropertyView` records property and attribute writes
 * regardless of tombstone state, and `restoreFromTombstone` (undoing the local
 * delete) clears only the tombstone, so a write accepted while deleted comes
 * back live on the restored entity, in a slot the local user never edited.
 *
 * The guard lives at this collab boundary, not inside the view's write
 * methods, because undo/redo replay calls those unconditionally by design
 * (rationale in `mutation-bridge.tombstone.test.ts`). `applyRemoteAttribute`
 * (mutation-bridge.ts) and the three property helpers below all route through
 * `rejectIfLocallyDeleted`, so the check has one definition: before #5187 only
 * the attribute handler carried its own copy and the property handlers had
 * none.
 */

import type { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { ScalarValue } from './mutation-bridge';

/** The refusal reason for a write to a locally tombstoned entity, else null. */
export function rejectIfLocallyDeleted(view: MutablePropertyView, entityId: number): string | null {
  return view.isDeleted(entityId) ? `entity ${entityId} is locally deleted` : null;
}

/** Apply an inbound property write, or return why it was refused. */
export function applyRemoteProperty(
  view: MutablePropertyView,
  entityId: number,
  pset: string,
  prop: string,
  value: ScalarValue,
  type: PropertyValueType,
): string | null {
  const rejected = rejectIfLocallyDeleted(view, entityId);
  if (rejected) return rejected;
  view.setProperty(entityId, pset, prop, value, type);
  return null;
}

/** Apply an inbound property delete, or return why it was refused. */
export function applyRemotePropertyDelete(
  view: MutablePropertyView,
  entityId: number,
  pset: string,
  prop: string,
): string | null {
  const rejected = rejectIfLocallyDeleted(view, entityId);
  if (rejected) return rejected;
  view.deleteProperty(entityId, pset, prop);
  return null;
}

/** Apply an inbound whole-Pset delete, or return why it was refused. */
export function applyRemotePsetDelete(
  view: MutablePropertyView,
  entityId: number,
  pset: string,
): string | null {
  const rejected = rejectIfLocallyDeleted(view, entityId);
  if (rejected) return rejected;
  view.deletePropertySet(entityId, pset);
  return null;
}
