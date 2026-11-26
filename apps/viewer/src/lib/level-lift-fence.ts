/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Exploded lift an asynchronous upload captured (#10264): released geometry
 * replayed from the backing must arrive at the same level as a resident upload
 * would (`placeNewMeshesAtCurrentLevel`). The applied offsets live in Maps that
 * may be mutated in place, so the fence compares the recomputed lift entry by
 * entry, never the Map identity.
 */

import type { FederatedModel } from '@/store/types';
import type { AppliedEntityLevelOffsets } from '@/store/slices/levelDisplaySlice';
import { currentLevelYForModels } from './level-arrival.js';

interface LevelState { models: ReadonlyMap<string, FederatedModel>; appliedEntityLevelOffsets: AppliedEntityLevelOffsets }

export interface CapturedLevelLift {
  /** The lift captured now: per global id, the Y offset to apply at arrival. */
  readonly lift: ReadonlyMap<number, number>;
  /** Whether `state` still lifts exactly as captured. */
  current(state: LevelState): boolean;
}

export function captureLevelLift(state: LevelState): CapturedLevelLift {
  const lift = currentLevelYForModels(state.models, state.appliedEntityLevelOffsets);
  const entries = [...lift];
  return {
    lift,
    current(now) {
      const live = currentLevelYForModels(now.models, now.appliedEntityLevelOffsets);
      return live.size === entries.length && entries.every(([id, y]) => live.get(id) === y);
    },
  };
}
