/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Make a wall fixed-height inside an inspector edit (#9013), as
 * `clearTopAttachment` does: a wall Revit recorded as attached gets an
 * explicit `Fixed` record (the Revit property is the file's own), any other
 * loses its IfcLite one. Every inspector path that types a wall height runs
 * this in the same Undo step, so re-levelling a storey never replaces it.
 */

import { FIXED_HEIGHT, STOREY_ATTACHMENT_PSET, readStoreyInventory, readTopAttachment } from '@ifc-lite/create';
import { PropertyValueType } from '@ifc-lite/data';
import type { AuthoringTransaction } from '@/lib/commands/modeling/types';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';

export function fixWallTop(tx: AuthoringTransaction, modelId: string, wallId: number): void {
  const s = tx.store;
  const target = modelEditTarget(s, modelId);
  const attachment = target ? readTopAttachment(readStoreyInventory(target.dataStore, target.view), wallId) : null;
  if (!attachment) return;
  if (attachment.source === 'revit') {
    if (!s.setProperty(modelId, wallId, STOREY_ATTACHMENT_PSET, 'TopConstraint', FIXED_HEIGHT, PropertyValueType.Label)) {
      throw new Error(`Couldn't make wall #${wallId} fixed-height`);
    }
  } else {
    s.deleteProperty(modelId, wallId, STOREY_ATTACHMENT_PSET, 'TopConstraint');
  }
}
