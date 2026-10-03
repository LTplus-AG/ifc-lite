/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { COPY_BATCH_LIMIT } from './copy-batch.js';
import type { CopyTransform } from './copy-product.js';

export interface CopyArrayParams {
  readonly mode: 'linear' | 'polar';
  /** Items including the original, at least two. */
  readonly count: number;
  /** Storey-local direction start (linear) or rotation centre (polar), metres. */
  readonly anchor: readonly [number, number] | null;
  readonly cursor?: readonly [number, number] | null;
  /** Typed linear spacing, or total span with fit; omitted follows cursor. */
  readonly distance?: number | null;
  readonly fit?: boolean;
  /** Polar span in degrees; a full turn excludes the coincident last copy. */
  readonly angleDegrees?: number;
}

/** The same placement planner for viewer previews, commits and public arrays (#6232 D5). */
export function arrayCopyTransforms(params: CopyArrayParams): CopyTransform[] | null {
  const { mode, count, anchor, cursor } = params;
  if (!Number.isSafeInteger(count) || count < 2) throw new Error('Array count must be an integer of at least two');
  if (count - 1 > COPY_BATCH_LIMIT) throw new Error(`An array may contain at most ${COPY_BATCH_LIMIT} new copies`);
  if (!anchor) return null;
  if (!anchor.every(Number.isFinite) || (cursor && !cursor.every(Number.isFinite))) throw new Error('Array points must contain finite metre coordinates');
  const copies = Array.from({ length: count - 1 }, (_, i) => i + 1);
  if (mode === 'polar') {
    const angle = params.angleDegrees ?? 360;
    if (!Number.isFinite(angle) || angle === 0 || Math.abs(angle) > 360) throw new Error('Polar span must be nonzero finite degrees within one turn');
    const step = Math.abs(angle) >= 360 ? (Math.sign(angle) * 360) / count : angle / (count - 1);
    return copies.map((i) => ({ turn: (step * i * Math.PI) / 180, pivot: [anchor[0], anchor[1]] }));
  }
  if (!cursor) return null;
  const clicked = Math.hypot(cursor[0] - anchor[0], cursor[1] - anchor[1]);
  if (clicked < 1e-6) return null;
  const distance = params.distance ?? clicked;
  if (!Number.isFinite(distance) || distance <= 0) throw new Error('Linear array distance must be positive finite metres');
  const ux = (cursor[0] - anchor[0]) / clicked, uy = (cursor[1] - anchor[1]) / clicked;
  const step = params.fit ? distance / (count - 1) : distance;
  return copies.map((i) => ({ offset: [ux * step * i, uy * step * i, 0] }));
}
