/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useGanttSelection3DSync — isolates 3D viewport to the products owned by
 * the currently-selected Gantt task(s).
 *
 * Behaviour:
 *   • When `selectedTaskGlobalIds` becomes non-empty AND `ganttSync3D` is
 *     on, compute the union of every *descendant* task's productExpressIds
 *     (so selecting a parent row reveals every leaf below it), translate to
 *     federated global IDs, and call `setIsolatedEntities(Set)`.
 *   • When the selection clears, we restore the user's pre-sync isolation
 *     state — we only own the isolation while the Gantt selection is
 *     active. Ownership is tracked in a ref (mirrors the pattern in
 *     `useConstructionSequence`) so the user can run selection → isolate →
 *     select nothing → back to whatever they had before.
 *   • When `ganttSync3D` is turned OFF while owning isolation, we restore
 *     the prior state immediately — the master toggle is an instant
 *     "unlink" action, not just a gate for future actions.
 *
 * Does NOT own `hiddenEntities`. The 4D animator does that during
 * playback; this hook only touches `isolatedEntities`. Run order in
 * GanttPanel: animator first, then this hook, so the isolation wraps the
 * animator's hidden set (both filters apply).
 */

import { useEffect, useRef } from 'react';
import { useViewerStore, toGlobalIdFromModels } from '@/store';
import { collectProductLocalIdsForTasks } from './schedule-selection';

interface ContributedIsolation {
  /** The set we wrote — used to detect "we still own this" on the next tick. */
  owned: Set<number>;
  /** What the user's isolation was before we took ownership. `null` = show-all. */
  prior: Set<number> | null;
}

export function useGanttSelection3DSync(): void {
  const scheduleData = useViewerStore(s => s.scheduleData);
  const selectedTaskGlobalIds = useViewerStore(s => s.selectedTaskGlobalIds);
  const ganttSync3D = useViewerStore(s => s.ganttSync3D);

  /** Ref to what we last wrote, plus what the prior user state was. */
  const ownedRef = useRef<ContributedIsolation | null>(null);

  useEffect(() => {
    const store = useViewerStore.getState();
    const currentIsolation = store.isolatedEntities;

    const restorePrior = () => {
      const owned = ownedRef.current;
      if (!owned) return;
      // Only restore if we still own it — if the user manually changed
      // isolation since our last write, leave their change in place.
      const weStillOwn = currentIsolation !== null
        && currentIsolation.size === owned.owned.size
        && [...owned.owned].every(id => currentIsolation.has(id));
      if (weStillOwn) {
        store.setIsolatedEntities(owned.prior);
      }
      ownedRef.current = null;
    };

    // ── Sync disabled or nothing selected → restore whatever we owned ──
    if (!ganttSync3D || !scheduleData || selectedTaskGlobalIds.size === 0) {
      restorePrior();
      return;
    }

    // ── Compute the target isolation set ──────────────────────────────
    const localIds = collectProductLocalIdsForTasks(
      scheduleData, selectedTaskGlobalIds,
    );
    if (localIds.size === 0) {
      // Selected tasks own no products (e.g. summary rows with no direct
      // assignment and no children either). Keep whatever isolation was
      // already in place — don't strand the user with nothing visible.
      restorePrior();
      return;
    }

    const activeModelId = store.activeModelId;
    const models = store.models;
    const sourceModelId = activeModelId
      ?? (models.size === 1 ? (models.keys().next().value ?? '') : '');

    const globalIds = new Set<number>();
    for (const local of localIds) {
      globalIds.add(toGlobalIdFromModels(models, sourceModelId, local));
    }

    // ── Take ownership on the first write, remember the prior state ───
    if (ownedRef.current === null) {
      ownedRef.current = {
        owned: globalIds,
        prior: currentIsolation ? new Set(currentIsolation) : null,
      };
      store.setIsolatedEntities(globalIds);
      return;
    }

    // ── Already owning — update only if the set changed ───────────────
    const prevOwned = ownedRef.current.owned;
    const same = prevOwned.size === globalIds.size
      && [...globalIds].every(id => prevOwned.has(id));
    if (!same) {
      ownedRef.current = { ...ownedRef.current, owned: globalIds };
      store.setIsolatedEntities(globalIds);
    }
  }, [scheduleData, selectedTaskGlobalIds, ganttSync3D]);

  // Unmount cleanup — release ownership so the user's isolation isn't
  // stuck at whatever the Gantt left pinned.
  useEffect(() => {
    return () => {
      const owned = ownedRef.current;
      if (!owned) return;
      const store = useViewerStore.getState();
      const currentIsolation = store.isolatedEntities;
      const weStillOwn = currentIsolation !== null
        && currentIsolation.size === owned.owned.size
        && [...owned.owned].every(id => currentIsolation.has(id));
      if (weStillOwn) {
        store.setIsolatedEntities(owned.prior);
      }
      ownedRef.current = null;
    };
  }, []);
}
