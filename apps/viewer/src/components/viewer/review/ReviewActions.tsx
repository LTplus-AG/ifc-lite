/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useViewerStore } from '@/store';
import { useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { addCardsToReport, draftTopicsFromCards } from '@/lib/review/actions';
import type { CoordinationCard, ReviewTotals } from '@/lib/review/cards';

export interface CardActions {
  busy: boolean;
  notes: string[];
  draft: (cards: readonly CoordinationCard[]) => Promise<void>;
  report: (cards: readonly CoordinationCard[], totals: ReviewTotals) => Promise<void>;
}

export function useCardActions(): CardActions {
  const { t, locale } = useTranslation();
  const panels = usePanelControls();
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const name = () => t('reviewWorkspace.actions.reportName', { date: new Date().toLocaleDateString(locale) });
  const draft = useCallback(async (cards: readonly CoordinationCard[]) => {
    setBusy(true);
    try {
      const result = await draftTopicsFromCards(name(), cards);
      const hasTopic = result.exclusions.filter(item => item.reason === 'has-topic').length;
      const notCurrent = result.exclusions.filter(item => item.reason === 'not-current').length;
      const next = [
        result.batch ? t(result.saved ? 'reviewWorkspace.actions.draftSaved' : 'reviewWorkspace.actions.draftUnsaved', { count: result.batch.topics.length })
          : t('reviewWorkspace.actions.draftNone'),
        ...(hasTopic ? [t('reviewWorkspace.actions.excludedHasTopic', { count: hasTopic })] : []),
        ...(notCurrent ? [t('reviewWorkspace.actions.excludedNotCurrent', { count: notCurrent })] : []),
      ];
      setNotes(next);
      if (result.saved) toast.success(next[0], { label: t('reviewWorkspace.actions.openDrafts'), onClick: () => {
        useBcfDraftLibrary.setState({ dialogOpen: true });
        useViewerStore.getState().setBcfPanelVisible(true);
      } });
    } catch (error) {
      console.error('[Review] Could not draft BCF topics', error);
      setNotes([t('reviewWorkspace.actions.draftFailed')]);
    } finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale]);
  const report = useCallback(async (cards: readonly CoordinationCard[], totals: ReviewTotals) => {
    setBusy(true);
    try {
      const result = await addCardsToReport(name(), cards, totals);
      const count = cards.length;
      setNotes([t(result.saved ? 'reviewWorkspace.actions.reportSaved' : 'reviewWorkspace.actions.reportUnsaved', { count })]);
      if (result.saved) toast.success(t('reviewWorkspace.actions.reportSaved', { count }),
        { label: t('reviewWorkspace.actions.openDocument'), onClick: () => { useViewerStore.getState().setActiveDocumentId(result.id); panels.openInHome('document', 'context'); } });
    } catch (error) {
      console.error('[Review] Could not create the report', error);
      setNotes([t('reviewWorkspace.actions.reportFailed')]);
    } finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale, panels]);
  return { busy, notes, draft, report };
}

/** Draft BCF topics / add to report for the selected cards, or for every card shown when none is selected. */
export function ReviewActions({ cards, selectedCount, totals, actions, onSelectAll, onClearSelection }: {
  cards: readonly CoordinationCard[]; selectedCount: number; totals: ReviewTotals; actions: CardActions;
  onSelectAll: () => void; onClearSelection: () => void;
}) {
  const { t } = useTranslation();
  const count = cards.length;
  return (
    <div className="space-y-1.5 px-3 py-2 border-b border-border">
      <p className="text-2xs text-muted-foreground">{t(selectedCount > 0 ? 'reviewWorkspace.actions.scopeSelected' : 'reviewWorkspace.actions.scopeShown')}</p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={actions.busy || count === 0} onClick={() => void actions.draft(cards)}>{t('reviewWorkspace.actions.draftTopics', { count })}</Button>
        <Button size="sm" variant="outline" disabled={actions.busy || count === 0} onClick={() => void actions.report(cards, totals)}>{t('reviewWorkspace.actions.addToReport', { count })}</Button>
        <Button size="sm" variant="ghost" onClick={onSelectAll}>{t('reviewWorkspace.actions.selectAll')}</Button>
        {selectedCount > 0 && <Button size="sm" variant="ghost" onClick={onClearSelection}>{t('reviewWorkspace.actions.clearSelection')}</Button>}
      </div>
      <div aria-live="polite" className="text-2xs text-muted-foreground space-y-0.5">{actions.notes.map(note => <p key={note}>{note}</p>)}</div>
    </div>
  );
}
