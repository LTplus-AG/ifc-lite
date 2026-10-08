/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '@/store';
import { readElementSize } from '@/store/slices/mutation-element-size';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { readWallMetres } from '@/store/slices/mutation-wall-resize';
import type { ExpectedSize } from './model-authoring-size-params';

/** Read only the existing native editable dimensions, in metres. */
export function readAuthoringSize(state: ViewerState, modelId: string, expressId: number, kind: ExpectedSize['kind']): ExpectedSize | null {
  if (kind === 'wall') {
    const target = modelEditTarget(state, modelId);
    const wall = target ? readWallMetres(target, expressId) : null;
    return wall ? { kind, height: wall.height, thickness: wall.thickness } : null;
  }
  const size = readElementSize(state, modelId, expressId);
  return size?.kind === kind ? size : null;
}

/** Native optional section/dimension fields must agree, including explicit zero. */
export function sameNativeDimensions(a: object, b: object): boolean {
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(key =>
    typeof left[key] === 'number' && typeof right[key] === 'number'
      ? Math.abs(left[key] - right[key]) <= 1e-9
      : left[key] === right[key]);
}
