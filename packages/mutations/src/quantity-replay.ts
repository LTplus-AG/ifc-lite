/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { QuantityType, type QuantitySet } from '@ifc-lite/data';
import type { Mutation } from './types.js';
import { findQuantityInBaseSets } from './base-qset-lookup.js';

type QuantityReplayTarget = {
  getQuantitiesForEntity?(entityId: number): QuantitySet[];
  setQuantity(entityId: number, qsetName: string, name: string, value: number,
    type: QuantityType, unit?: string | null, skipHistory?: boolean): unknown;
};

/** Replay a single quantity value edit with its recorded metadata (#6232). */
export function replayQuantityMutation(
  target: QuantityReplayTarget,
  mutation: Mutation,
  direction: 'undo' | 'redo' = 'redo',
  skipHistory = false,
): void {
  const value = direction === 'undo' ? mutation.oldValue : mutation.newValue;
  if (!mutation.psetName || !mutation.propName || value === undefined || (direction === 'undo' && value === null)) return;
  const needsCurrent = direction === 'undo'
    ? mutation.oldQuantityType === undefined || mutation.oldUnit === undefined
    : mutation.quantityType === undefined;
  const current = needsCurrent && target.getQuantitiesForEntity
    ? findQuantityInBaseSets(target.getQuantitiesForEntity(mutation.entityId), mutation.psetName, mutation.propName)
    : undefined;
  // Older history never captured prior metadata. Restoring its value retains
  // the current class/unit; a prior type change cannot be reconstructed.
  const type = direction === 'undo' ? mutation.oldQuantityType ?? current?.type : mutation.quantityType ?? current?.type;
  const unit = direction === 'undo'
    ? mutation.oldUnit === null ? null : mutation.oldUnit ?? current?.unit
    : mutation.unitRemoved ? null : mutation.quantityType === undefined ? mutation.unit ?? current?.unit : mutation.unit;
  target.setQuantity(mutation.entityId, mutation.psetName, mutation.propName, Number(value), (type ?? QuantityType.Count) as QuantityType, unit, skipHistory);
}
