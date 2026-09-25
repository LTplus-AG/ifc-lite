/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every mechanism that can keep geometry off screen, in one table (#5869).
 *
 * Before this, each reset (Show all, Home, the "A" key, the context menu)
 * hand-listed the channels it cleared, and every list missed a different
 * few: a hidden federated model, for one, survived all of them. A reset is now
 * "clear every row whose policy is `cleared`", and the rows it deliberately
 * keeps are named here, so a chip (#5882) can say so instead of the user
 * wondering why Show all did not show everything.
 *
 * `kept` rows are preferences or configuration rather than a filter the user
 * applied to this view: the active lens (it keeps its colours through a reset
 * too, #5877), the persisted class-type toggles (resetting them to defaults
 * would turn Spaces back OFF — hiding more, not less), the Model/Types view
 * mode, and an embedding host's hidden classes.
 *
 * Every row reads global ids or per-model flags, so it holds at 1 and N models.
 */

import type { ViewerState } from '@/store';
import { TYPE_VISIBILITY_SEMANTIC_DEFAULTS } from '@/store/constants';
import type { TypeVisibility } from '@/store/types';
import { hiddenChannelAfterReset } from './lens-reset';

export type VisibilityReasonId =
  | 'hidden'
  | 'isolation'
  | 'ghost'
  | 'classFilter'
  | 'storey'
  | 'modelHidden'
  | 'lens'
  | 'typeVisibility'
  | 'typeViewMode'
  | 'hostTypes';

export type VisibilityResetPolicy = 'cleared' | 'kept';

/** The store surface a reason reads and writes: the whole viewer store. */
export interface VisibilityStore {
  getState(): ViewerState;
  setState(patch: Partial<ViewerState>): void;
}

export interface VisibilityReason {
  id: VisibilityReasonId;
  /** What Show all / Home does with it. */
  policy: VisibilityResetPolicy;
  isActive(state: ViewerState): boolean;
  /** Turn just this mechanism off (a chip's ×, or the reset for `cleared` rows). */
  clear(store: VisibilityStore): void;
}

/** Class-type toggles that are ON by default but the user turned OFF. */
export function hiddenTypeToggles(typeVisibility: TypeVisibility): (keyof TypeVisibility)[] {
  return (Object.keys(TYPE_VISIBILITY_SEMANTIC_DEFAULTS) as (keyof TypeVisibility)[])
    .filter((key) => TYPE_VISIBILITY_SEMANTIC_DEFAULTS[key] && !typeVisibility[key]);
}

function hiddenModelIds(state: ViewerState): string[] {
  return [...state.models.values()].filter((m) => !m.visible).map((m) => m.id);
}

export const VISIBILITY_REASONS: readonly VisibilityReason[] = [
  {
    id: 'hidden',
    policy: 'cleared',
    // The active lens's own hides live in the same channel, owned by the lens
    // (#5877); they are the lens row's, not this one's.
    isActive: (s) => {
      const lensOwned = new Set(s.activeLensId ? s.lensAppliedHiddenIds : []);
      for (const id of s.hiddenEntities) if (!lensOwned.has(id)) return true;
      return false;
    },
    // What stays is exactly the active lens's hides, all lens-owned (#5877).
    clear: (store) => {
      const { activeLensId, lensHiddenIds } = store.getState();
      store.setState(hiddenChannelAfterReset(activeLensId, lensHiddenIds));
    },
  },
  {
    id: 'isolation',
    policy: 'cleared',
    isActive: (s) => s.isolatedEntities !== null,
    // Leaving the basket view goes with it; the basket's CONTENTS are not a
    // visibility reason and survive (Home empties them separately).
    clear: (store) => {
      store.getState().clearIsolation();
      store.setState({ activeBasketViewId: null });
    },
  },
  {
    id: 'ghost',
    policy: 'cleared',
    isActive: (s) => s.ghostExceptEntities !== null,
    clear: (store) => store.getState().clearGhost(),
  },
  {
    id: 'classFilter',
    policy: 'cleared',
    isActive: (s) => s.classFilter !== null,
    clear: (store) => store.getState().clearClassFilter(),
  },
  {
    id: 'storey',
    policy: 'cleared',
    // Solo rides this channel too (`applyLevelDisplayMode`); the level-display
    // guard drops Solo back to Stacked once the selection empties.
    isActive: (s) => s.selectedStoreys.size > 0,
    clear: (store) => store.getState().clearStoreySelection(),
  },
  {
    id: 'modelHidden',
    policy: 'cleared',
    isActive: (s) => hiddenModelIds(s).length > 0,
    clear: (store) => {
      const s = store.getState();
      s.setModelsVisibility(hiddenModelIds(s), true);
    },
  },
  {
    id: 'lens',
    policy: 'kept',
    isActive: (s) => s.activeLensId !== null && s.lensHiddenIds.size > 0,
    clear: (store) => store.setState({ activeLensId: null }),
  },
  {
    id: 'typeVisibility',
    policy: 'kept',
    isActive: (s) => hiddenTypeToggles(s.typeVisibility).length > 0,
    clear: (store) => {
      const s = store.getState();
      for (const key of hiddenTypeToggles(s.typeVisibility)) s.toggleTypeVisibility(key);
    },
  },
  {
    id: 'typeViewMode',
    policy: 'kept',
    isActive: (s) => s.typeViewMode === 'types' && s.hasTypeGeometry,
    clear: (store) => store.getState().setTypeViewMode('model'),
  },
  {
    id: 'hostTypes',
    policy: 'kept',
    // Set by an embedding page, not the user: no chip × clears it either.
    isActive: (s) => (s.hostHiddenIfcTypes?.size ?? 0) > 0,
    clear: () => {},
  },
];

/** The mechanisms hiding geometry right now, in table order. */
export function activeVisibilityReasons(state: ViewerState): VisibilityReason[] {
  return VISIBILITY_REASONS.filter((reason) => reason.isActive(state));
}

/** Show all / Home: clear every active `cleared` mechanism; `kept` ones stay. */
export function resetVisibilityReasons(store: VisibilityStore): void {
  for (const reason of VISIBILITY_REASONS) {
    if (reason.policy === 'cleared' && reason.isActive(store.getState())) reason.clear(store);
  }
}
