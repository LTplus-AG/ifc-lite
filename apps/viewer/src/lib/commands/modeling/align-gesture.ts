/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gesture of `element.align` (charter #6232, C4) and the moves it would
 * make, apart from the command so its bar and layers can read them without
 * importing it back.
 */

import type { AlignMode, PlanBox } from './align-boxes.js';

export interface AlignGesture {
  /** The session storey's elements with geometry, in the session workplane. */
  readonly boxes: ReadonlyMap<number, PlanBox>;
  readonly reference: number | null;
  readonly targets: readonly number[];
  /** Dependants whose selected host governs the preview and commit. */
  readonly carried?: readonly number[];
  readonly mode: AlignMode;
  readonly hover: number | null;
}

export { alignMoves } from '@ifc-lite/create';
