/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ClipBox, ExtraClipPlane } from './types.js';

/** Options for GPU picking/selection, matching rendered visibility. */
export interface PickOptions {
  isStreaming?: boolean;
  hiddenIds?: Set<number>;
  isolatedIds?: Set<number> | null;
}

/** Clip state the GPU picker mirrors from the most recent rendered frame. */
export interface PickClipState {
  /** Full scene ids exempt from primary and extra section planes; crop boxes still apply. */
  sectionExcludedIds?: ReadonlySet<number>;
  sectionPlane?: { normal: [number, number, number]; distance: number; flipped: boolean } | null;
  /** Further planes (#7545), world-space; the picker clips against all of them. */
  extraPlanes?: readonly ExtraClipPlane[] | null;
  clipBox?: ClipBox | null;
}
