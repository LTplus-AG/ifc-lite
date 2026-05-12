/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useGanttSelection3DHighlight — selecting Gantt row(s) **highlights** their
 * products in the 3D viewport. No isolation, no hiding, no color overlay —
 * purely the renderer's existing selection-highlight channel
 * (`selectedEntityIds`), which paints a blue fresnel on top of whatever the
 * object already looks like and leaves visibility untouched.
 *
 * This means:
 *   • The 4D animator's `hiddenIds` / color overlays run completely
 *     undisturbed during playback — the highlight only applies to whatever
 *     is *currently visible* in that frame, because hidden entities aren't
 *     drawn at all.
 *   • Clearing the Gantt selection restores whatever viewport selection
 *     the user had before we wrote. Ownership is tracked in a ref so a
 *     user 3D-click in between is never clobbered on teardown.
 *   • Unmount (Gantt panel closed) and schedule reload also restore.
 *
 * One-way only: viewport → Gantt sync is intentionally NOT implemented
 * here. Simpler mental model: "I clicked a Gantt row → I see my task in
 * 3D." Nothing else.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore, toGlobalIdFromModels } from '@/store';
import { resolveScheduleSourceModelId } from '@/store/slices/schedule-edit-helpers';
import { collectProductLocalIdsForTasks } from './schedule-selection';

interface OwnedHighlight {
  /** Global IDs we wrote as viewport selection. */
  owned: Set<number>;
  /** User's viewport selection before we took over. Restored on clear. */
  prior: Set<number>;
  priorPrimary: number | null;
}

export function useGanttSelection3DHighlight(): void {
  const scheduleData = useViewerStore(s => s.scheduleData);
  const selectedTaskGlobalIds = useViewerStore(s => s.selectedTaskGlobalIds);

  /** What we last wrote + the user's prior selection. null = we don't own. */
  const ownedRef = useRef<OwnedHighlight | null>(null);

  useEffect(() => {
    const store = useViewerStore.getState();

    /**
     * Returns true iff the current viewport selection is byte-for-byte the
     * set we last wrote. If the user has clicked in 3D since, we lost
     * ownership and must not clobber their choice on teardown.
     */
    const weStillOwn = (owned: Set<number>): boolean => {
      const current = store.selectedEntityIds;
      if (current.size !== owned.size) return false;
      for (const id of owned) if (!current.has(id)) return false;
      return true;
    };

    const restorePrior = () => {
      const owned = ownedRef.current;
      if (!owned) return;
      if (weStillOwn(owned.owned)) {
        // Restore the user's prior selection (often empty — the common case).
        store.setSelectedEntityIds(Array.from(owned.prior));
        if (owned.priorPrimary !== null) {
          store.setSelectedEntityId(owned.priorPrimary);
        }
      }
      ownedRef.current = null;
    };

    // ── Gantt selection empty → release ownership and restore ─────────
    if (!scheduleData || selectedTaskGlobalIds.size === 0) {
      restorePrior();
      return;
    }

    // ── Compute global IDs for every descendant product ───────────────
    const localIds = collectProductLocalIdsForTasks(scheduleData, selectedTaskGlobalIds);
    if (localIds.size === 0) {
      // Selected tasks own no products — treat as "nothing to highlight"
      // and restore rather than stranding the user with a stale highlight.
      restorePrior();
      return;
    }

    const models = store.models;
    const activeModelId = store.activeModelId;
    const sourceModelId = resolveScheduleSourceModelId(models, activeModelId);

    const globalIds = new Set<number>();
    for (const local of localIds) {
      globalIds.add(toGlobalIdFromModels(models, sourceModelId, local));
    }

    // ── First write: capture the user's prior selection so we can restore ──
    if (ownedRef.current === null) {
      ownedRef.current = {
        owned: globalIds,
        prior: new Set(store.selectedEntityIds),
        priorPrimary: store.selectedEntityId,
      };
      store.setSelectedEntityIds(Array.from(globalIds));
      return;
    }

    // ── Subsequent writes: update only if the set actually changed ────
    const prevOwned = ownedRef.current.owned;
    let same = prevOwned.size === globalIds.size;
    if (same) {
      for (const id of globalIds) if (!prevOwned.has(id)) { same = false; break; }
    }
    if (!same) {
      // Only overwrite if we still own — otherwise a user 3D-click took
      // priority and we shouldn't clobber it. If they then change the
      // Gantt selection again, we simply take ownership from scratch.
      if (weStillOwn(prevOwned)) {
        ownedRef.current = { ...ownedRef.current, owned: globalIds };
        store.setSelectedEntityIds(Array.from(globalIds));
      } else {
        ownedRef.current = {
          owned: globalIds,
          prior: new Set(store.selectedEntityIds),
          priorPrimary: store.selectedEntityId,
        };
        store.setSelectedEntityIds(Array.from(globalIds));
      }
    }
  }, [scheduleData, selectedTaskGlobalIds]);

  // Unmount teardown — release if we still own the selection.
  useEffect(() => {
    return () => {
      const owned = ownedRef.current;
      if (!owned) return;
      const store = useViewerStore.getState();
      const current = store.selectedEntityIds;
      const stillOwn = current.size === owned.owned.size
        && [...owned.owned].every(id => current.has(id));
      if (stillOwn) {
        store.setSelectedEntityIds(Array.from(owned.prior));
        if (owned.priorPrimary !== null) {
          store.setSelectedEntityId(owned.priorPrimary);
        }
      }
      ownedRef.current = null;
    };
  }, []);
}
