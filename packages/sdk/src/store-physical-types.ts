/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ElementTransformInput, ElementSplitRequest, ElementTrimExtendParams } from '@ifc-lite/create';
import type { EntityRef } from './types.js';

/** Physical geometry dimensions in metres, retaining EXPRESS solid/profile names. */
export type PhysicalSizePatch =
  | { kind: 'wall'; Height?: number; Thickness?: number }
  | { kind: 'slab'; Thickness: number }
  | { kind: 'linear'; Depth?: number; XDim?: number; YDim?: number; fixed?: 'start' | 'end' };
export interface PhysicalStoreBackendMethods {
  transformElements?(modelId: string, expressIds: readonly number[], operation: ElementTransformInput['op']): EntityRef[];
  setElementSize?(ref: EntityRef, patch: PhysicalSizePatch): EntityRef[];
  resizeWall?(ref: EntityRef, start: [number, number, number], end: [number, number, number], options?: { moveJoinedEnds?: boolean }): EntityRef[];
  splitElements?(modelId: string, requests: readonly ElementSplitRequest[]): { source: EntityRef; added: EntityRef; left: EntityRef; right: EntityRef }[];
  trimExtendElement?(ref: EntityRef, params: ElementTrimExtendParams): EntityRef[];
}
