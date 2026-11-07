/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The HUD line about aiming through to the workplane (#9201): the offer while
 * the pointer reads what you see, and what is happening while it doesn't.
 * Nothing for a command whose pointer never aims through.
 */

import type { TranslationKey } from '@/i18n';
import type { SnapResult } from '@/lib/snap/types';
import { pointerAim } from './snap-solve.js';
import type { ModelingCommand, Workplane } from './types.js';

export interface AimHint {
  key: TranslationKey;
  /** The pointer is aiming through right now. */
  active: boolean;
}

export function aimHint<G>(
  command: ModelingCommand<G>,
  gesture: G,
  plane: Workplane | null,
  snapEnabled: boolean,
  snap: SnapResult | null,
): AimHint | null {
  if (!plane || pointerAim(command, gesture, plane, false, false) !== 'through') return null;
  if (!snapEnabled) return { key: 'modelingCommand.aim.snapOff', active: true };
  if (snap?.modifiers?.alt) return { key: 'modelingCommand.aim.altHeld', active: true };
  return { key: 'modelingCommand.aim.holdAlt', active: false };
}
