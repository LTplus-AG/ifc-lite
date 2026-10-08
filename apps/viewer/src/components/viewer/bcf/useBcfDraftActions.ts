/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Create BCF draft batches from the live clash run (#6896). */

import { useCallback, useState } from 'react';
import type { Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { bcfWorldOffset } from '@/hooks/bcf/viewpoint-world-frame';
import { resolveManualClashGroups } from '@/lib/clash/manual-groups';
import { DEFAULT_GROUP_WORKSPACE, useClashGroupLibrary } from '@/lib/clash/group-workspace';
import { draftBatchFromGroups, draftBatchFromSelection, type DraftRun } from '@/lib/bcf-drafts/draft-create';
import { saveDraftBatch, useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';

/** The run drafts are made from and reconciled against: the filtered result the panel shows. */
export function currentDraftRun(): DraftRun | null {
  const state = useViewerStore.getState();
  const result = state.clashResult;
  if (!result) return null;
  return { clashes: result.clashes, rules: result.rulesRun.map(rule => rule.id), worldOffset: bcfWorldOffset(state.models, state.geometryResult) };
}

export function useBcfDraftActions() {
  const { t } = useTranslation();
  const [drafting, setDrafting] = useState(false);
  const open = useCallback((batch: DraftBatch) => {
    useBcfDraftLibrary.setState({ activeId: batch.id, dialogOpen: true });
    useViewerStore.getState().setBcfPanelVisible(true);
  }, []);
  const finish = useCallback(async (create: (run: DraftRun) => Promise<DraftBatch>) => {
    const run = currentDraftRun();
    if (!run) { toast.error(t('bcfDrafts.create.noRun')); return; }
    setDrafting(true);
    try {
      const batch = await create(run);
      if (batch.topics.length === 0) { toast.error(t('bcfDrafts.create.empty')); return; }
      const saved = await saveDraftBatch(batch);
      if (saved) toast.success(t('bcfDrafts.create.saved', { count: batch.topics.length }), { label: t('bcfDrafts.create.open'), onClick: () => open(batch) });
      else toast.info(t('bcfDrafts.create.unsaved'), { label: t('bcfDrafts.create.open'), onClick: () => open(batch) });
    } catch (error) {
      console.error('[BCF drafts] Could not draft topics', error);
      toast.error(t('bcfDrafts.create.failed'));
    } finally {
      setDrafting(false);
    }
  }, [open, t]);

  /** One topic per group of the active grouping workspace, resolved in the current run. */
  const draftFromGroups = useCallback(() => finish(run => {
    const library = useClashGroupLibrary.getState();
    const workspace = library.entries.find(entry => entry.id === library.activeId);
    const groups = resolveManualClashGroups(workspace?.groups ?? [], run.clashes);
    return draftBatchFromGroups(workspace?.name ?? t('clashGroups.defaultWorkspace'), workspace?.id ?? DEFAULT_GROUP_WORKSPACE, groups, run);
  }), [finish, t]);

  const draftFromSelection = useCallback((selected: readonly Clash[]) => finish(run =>
    draftBatchFromSelection(t('bcfDrafts.create.selectionBatch'), t('bcfDrafts.create.selectionTopic', { count: selected.length }), selected, run)),
  [finish, t]);

  return { drafting, draftFromGroups, draftFromSelection };
}
