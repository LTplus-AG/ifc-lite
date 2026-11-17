/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BulkAction } from '@ifc-lite/mutations';
import type { FilterGroup } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import type { BulkTargetSource } from './bulk-targets';
import type { captureBulkTargetEngines } from './bulk-target-lifetime';

type Targets = ReturnType<typeof captureBulkTargetEngines>;

/** Infer the initial source on first open; subsequent openings retain the user's draft. */
export function useBulkTargetSource(open: boolean) {
  const [source, setSource] = useState<BulkTargetSource>('query');
  const initialized = useRef(false);
  useEffect(() => {
    if (!open || initialized.current) return;
    initialized.current = true;
    const state = useViewerStore.getState();
    setSource(state.models.size > 0 && (state.selectedEntityIds.size > 0 || state.selectedEntityId !== null)
      ? 'selection' : 'query');
  }, [open]);
  return [source, setSource] as const;
}

/** Only inputs consumed by the chosen source/action identify the semantic draft. */
export function bulkDraftKey(source: BulkTargetSource, modelId: string, groups: readonly FilterGroup[],
  targets: ReadonlyMap<string, readonly number[]>, built: { ok: true; action: BulkAction } | { ok: false }) {
  const criteria = source === 'query' ? { modelId, groups } : [...targets]
    .map(([id, ids]) => [id, [...ids].sort((a, b) => a - b)] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return JSON.stringify({ source, criteria, action: built.ok ? built.action : null });
}

/** Cleanliness survives transient result panels, closing, and unrelated model changes. */
export function useBulkCompletedDraft(key: string) {
  const [completed, setCompleted] = useState<{ key: string; targets: Targets } | null>(null);
  const participantsCurrent = completed?.targets.isCurrent() ?? true;
  useEffect(() => {
    if (!participantsCurrent) setCompleted(previous => previous && !previous.targets.isCurrent() ? null : previous); // Release retired data/views, not just their clean flag.
  }, [participantsCurrent]);
  const completeDraft = useCallback((key: string, targets: Targets) => setCompleted({ key, targets }), []);
  const resetDraft = useCallback(() => setCompleted(null), []);
  return { executeDirty: !completed || !participantsCurrent || completed.key !== key, completeDraft, resetDraft };
}
