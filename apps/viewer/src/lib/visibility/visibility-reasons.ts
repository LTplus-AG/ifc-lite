/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every mechanism that can keep geometry off screen, in one table (#5869).
 *
 * Before this, each reset (Show all, Home, the "A" key, the context menu)
 * hand-listed the channels it cleared, and every list missed a different
 * few: a hidden federated model, for one, survived all of them. A reset is now
 * "clear every row whose resetPolicy is `cleared`", and the rows it deliberately
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
import type { TranslationKey } from '@/i18n';
import { TYPE_VISIBILITY_SEMANTIC_DEFAULTS } from '@/store/constants';
import type { TypeVisibility } from '@/store/types';
import { hiddenChannelAfterReset } from './lens-reset';

export type VisibilityReasonId =
  | 'hidden'
  | 'isolation'
  | 'ghost'
  | 'classFilter'
  | 'storey'
  | 'exploded'
  | 'modelHidden'
  | 'lens'
  | 'typeVisibility'
  | 'typeViewMode'
  | 'hostTypes'
  | 'section'
  | 'measurements';

export type VisibilityResetPolicy = 'cleared' | 'kept';

/** The store surface a reason reads and writes: the whole viewer store. */
export interface VisibilityStore {
  getState(): ViewerState;
  setState(patch: Partial<ViewerState>): void;
}

export interface VisibilityReason {
  id: VisibilityReasonId;
  labelKey: TranslationKey;
  /** What Show all / Home does with it. */
  resetPolicy: VisibilityResetPolicy;
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
    labelKey: 'visibilityReasons.hidden',
    resetPolicy: 'cleared',
    // Hides matched by the active lens are attributed to the lens while it is
    // active. An overlapping manual hide keeps its ownership for teardown.
    isActive: (s) => {
      for (const id of s.hiddenEntities) {
        if (!s.activeLensId || !s.lensHiddenIds.has(id)) return true;
      }
      return false;
    },
    // Keep the lens's hides without claiming manually hidden overlaps, while
    // claiming any new match the lens has not synced into the channel yet.
    clear: (store) => {
      const { activeLensId, lensHiddenIds, lensAppliedHiddenIds, hiddenEntities } = store.getState();
      store.setState(hiddenChannelAfterReset(activeLensId, lensHiddenIds, lensAppliedHiddenIds, hiddenEntities));
    },
  },
  {
    id: 'isolation',
    labelKey: 'visibilityReasons.isolation',
    resetPolicy: 'cleared',
    isActive: (s) => s.isolatedEntities !== null,
    // Leaving the basket view goes with it; the basket's CONTENTS are not a
    // visibility reason and survive (Home empties them separately). A lens
    // rule's claim on the channel goes too: left behind, its row would still
    // read isolated and treat the next click as a stale release.
    clear: (store) => {
      store.getState().clearIsolation();
      store.setState({ activeBasketViewId: null, lensRuleIsolation: null });
    },
  },
  {
    id: 'ghost',
    labelKey: 'visibilityReasons.ghost',
    resetPolicy: 'cleared',
    isActive: (s) => s.ghostExceptEntities !== null,
    clear: (store) => store.getState().clearGhost(),
  },
  {
    id: 'classFilter',
    labelKey: 'visibilityReasons.classFilter',
    resetPolicy: 'cleared',
    isActive: (s) => s.classFilter !== null,
    clear: (store) => store.getState().clearClassFilter(),
  },
  {
    id: 'storey',
    labelKey: 'visibilityReasons.storey',
    resetPolicy: 'cleared',
    // Solo rides this channel too (`applyLevelDisplayMode`); the level-display
    // guard drops Solo back to Stacked once the selection empties.
    isActive: (s) => s.selectedStoreys.size > 0 || s.levelDisplayMode === 'solo',
    clear: (store) => {
      const s = store.getState();
      s.clearStoreySelection();
      if (s.levelDisplayMode === 'solo') s.setLevelDisplayMode('stacked');
    },
  },
  {
    id: 'exploded',
    labelKey: 'visibilityReasons.exploded',
    resetPolicy: 'cleared',
    isActive: (s) => s.levelDisplayMode === 'exploded',
    clear: (store) => store.getState().setLevelDisplayMode('stacked'),
  },
  {
    id: 'modelHidden',
    labelKey: 'visibilityReasons.modelHidden',
    resetPolicy: 'cleared',
    isActive: (s) => hiddenModelIds(s).length > 0,
    clear: (store) => {
      const s = store.getState();
      s.setModelsVisibility(hiddenModelIds(s), true);
    },
  },
  {
    id: 'lens',
    labelKey: 'visibilityReasons.lens',
    resetPolicy: 'kept',
    isActive: (s) => s.activeLensId !== null && s.lensHiddenIds.size > 0,
    clear: (store) => store.setState({ activeLensId: null }),
  },
  {
    id: 'typeVisibility',
    labelKey: 'visibilityReasons.typeVisibility',
    resetPolicy: 'kept',
    isActive: (s) => hiddenTypeToggles(s.typeVisibility).length > 0,
    clear: (store) => {
      const s = store.getState();
      for (const key of hiddenTypeToggles(s.typeVisibility)) s.toggleTypeVisibility(key);
    },
  },
  {
    id: 'typeViewMode',
    labelKey: 'visibilityReasons.typeViewMode',
    resetPolicy: 'kept',
    isActive: (s) => s.typeViewMode === 'types' && s.hasTypeGeometry,
    clear: (store) => store.getState().setTypeViewMode('model'),
  },
  {
    id: 'hostTypes',
    labelKey: 'visibilityReasons.hostTypes',
    resetPolicy: 'kept',
    // Set by an embedding page, not the user: no chip × clears it either.
    isActive: (s) => (s.hostHiddenIfcTypes?.size ?? 0) > 0,
    clear: () => {},
  },
  {
    id: 'section',
    labelKey: 'visibilityReasons.section',
    resetPolicy: 'cleared',
    // The cut itself (`sectionPlane.enabled`) and the toggle are independent
    // (#5893) — either can be off with the other on; only both together put
    // it on screen.
    isActive: (s) => s.sectionPlane.enabled && s.sceneState.section.visible,
    clear: (store) => store.getState().setSectionVisible(false),
  },
  {
    id: 'measurements',
    labelKey: 'visibilityReasons.measurements',
    resetPolicy: 'cleared',
    isActive: (s) =>
      (s.measurements.length > 0 || s.polylineMeasurements.length > 0) && s.sceneState.measurements.visible,
    clear: (store) => store.getState().setMeasurementsVisible(false),
  },
];

/** The mechanisms hiding geometry right now, in table order. */
export function activeVisibilityReasons(state: ViewerState): VisibilityReason[] {
  return VISIBILITY_REASONS.filter((reason) => reason.isActive(state));
}

/** Show all / Home: clear active resettable mechanisms; reconcile hides even when only the lens is active. */
export function resetVisibilityReasons(store: VisibilityStore): void {
  for (const reason of VISIBILITY_REASONS) {
    // The lens may have new matches before its sync effect hides them. Home
    // must still apply those matches, including their ownership (#5877).
    if (reason.resetPolicy === 'cleared' && (reason.id === 'hidden' || reason.isActive(store.getState()))) reason.clear(store);
  }
}
