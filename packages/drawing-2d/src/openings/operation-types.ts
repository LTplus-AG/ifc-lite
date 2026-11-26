/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DoorOperationType, WindowPartitioningType } from '../types.js';

const DOOR_OPERATIONS: Record<DoorOperationType, true> = {
  SINGLE_SWING_LEFT: true, SINGLE_SWING_RIGHT: true, DOUBLE_DOOR_SINGLE_SWING: true,
  DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_LEFT: true, DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_RIGHT: true,
  DOUBLE_DOOR_DOUBLE_SWING: true, DOUBLE_SWING_LEFT: true, DOUBLE_SWING_RIGHT: true,
  SLIDING_TO_LEFT: true, SLIDING_TO_RIGHT: true, DOUBLE_DOOR_SLIDING: true,
  FOLDING_TO_LEFT: true, FOLDING_TO_RIGHT: true, DOUBLE_DOOR_FOLDING: true,
  REVOLVING: true, ROLLINGUP: true, SWING_FIXED_LEFT: true, SWING_FIXED_RIGHT: true,
  USERDEFINED: true, NOTDEFINED: true,
};

const WINDOW_PARTITIONINGS: Record<WindowPartitioningType, true> = {
  SINGLE_PANEL: true, DOUBLE_PANEL_VERTICAL: true, DOUBLE_PANEL_HORIZONTAL: true,
  TRIPLE_PANEL_VERTICAL: true, TRIPLE_PANEL_HORIZONTAL: true, TRIPLE_PANEL_BOTTOM: true,
  TRIPLE_PANEL_TOP: true, TRIPLE_PANEL_LEFT: true, TRIPLE_PANEL_RIGHT: true,
  USERDEFINED: true, NOTDEFINED: true,
};

/** An IFC enumeration value as authored (`.SINGLE_SWING_LEFT.` or bare), upper-cased; null when blank. */
function enumToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.replace(/\./g, '').trim().toUpperCase();
  return token === '' ? null : token;
}

/**
 * A stated door operation, or null. NOTDEFINED states no handedness, so it reads
 * as absent and must not shadow a type's value (#8232). A stated value outside
 * this enumeration (an IFC4X3 `LIFTING_VERTICAL_LEFT`, say) reads as USERDEFINED.
 */
export function parseDoorOperation(value: unknown): DoorOperationType | null {
  const token = enumToken(value);
  if (token === null || token === 'NOTDEFINED') return null;
  return isDoorOperation(token) ? token : 'USERDEFINED';
}

/** A stated window partitioning, or null (NOTDEFINED reads as absent, an unknown value as USERDEFINED). */
export function parseWindowPartitioning(value: unknown): WindowPartitioningType | null {
  const token = enumToken(value);
  if (token === null || token === 'NOTDEFINED') return null;
  return isWindowPartitioning(token) ? token : 'USERDEFINED';
}

function isDoorOperation(token: string): token is DoorOperationType {
  return Object.hasOwn(DOOR_OPERATIONS, token);
}

function isWindowPartitioning(token: string): token is WindowPartitioningType {
  return Object.hasOwn(WINDOW_PARTITIONINGS, token);
}
