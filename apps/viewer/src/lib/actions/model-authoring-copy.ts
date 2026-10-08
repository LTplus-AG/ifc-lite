/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { arrayCopyTransforms, type CopyTransform } from '@ifc-lite/create';
import type { AuthoringOp, ModelAuthoringBatch } from './model-authoring';
import { toMetres } from './model-authoring';

export type CopyOp = Extract<AuthoringOp, { op: 'element.copy' | 'element.array' }>;
export const copyRefs = (op: CopyOp): readonly string[] => op.op === 'element.copy' ? [op.ref] : op.refs;

/** Convert declared lengths once, then use the Model workspace's exact planner. */
export function authoringCopyTransforms(batch: ModelAuthoringBatch, op: CopyOp, targetStoreyId?: number): CopyTransform[] {
  const m = (value: number) => toMetres(batch, value);
  const p = (point: readonly [number, number]): [number, number] => [m(point[0]), m(point[1])];
  const transforms: CopyTransform[] | null = op.op === 'element.copy'
    ? [{ offset: [m(op.offset[0]), m(op.offset[1]), m(op.offset[2])],
      ...(op.angleDeg === undefined ? {} : { turn: op.angleDeg * Math.PI / 180, pivot: p(op.pivot!) }) }]
    : arrayCopyTransforms({ mode: op.mode, count: op.count, anchor: p(op.anchor),
      cursor: op.cursor ? p(op.cursor) : undefined, distance: op.distance === undefined ? undefined : m(op.distance),
      fit: op.fit, angleDegrees: op.angleDeg });
  if (!transforms?.length) throw new Error('The array has no direction or copy placement');
  return transforms.map(transform => ({ ...transform, ...(targetStoreyId === undefined ? {} : { targetStoreyId }) }));
}
