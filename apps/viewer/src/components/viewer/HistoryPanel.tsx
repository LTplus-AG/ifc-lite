/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model version history — the "Time Machine" of
 * `docs/architecture/layer-prs/08-review.md` §8.5, built on a source's
 * commits rather than on an IFCX layer stack.
 *
 * The panel owns the STATES (§4.3 of the spec) and the wiring between them;
 * the timeline, the row and the compare bar are their own components, and
 * every fetch lives in a hook. What is left here is the decision tree a user
 * actually hits: no model, a model with no source, a revision-only source
 * that can list history but not open it, and the full commit-aware case.
 */

import { useCallback, useMemo } from 'react';
import { History, X } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import type { CommitRef, SourceCommit } from '@ifc-lite/plugin-api';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useCompare } from '@/hooks/useCompare';
import { useCommitCompare } from '@/hooks/history/useCommitCompare';
import { useShowCommitsIn3D } from '@/hooks/history/useCommitCompare3D';
import { useCommitLoad } from '@/hooks/history/useCommitLoad';
import { useCommitWatch } from '@/hooks/history/useCommitWatch';
import { useModelHistory } from '@/hooks/history/useModelHistory';
import { buildCommitRows, orderCompareSlots } from '@/lib/history/commitGraph';
import { commitModelDisplayName } from '@/lib/history/commitLabels';
import { getLocale } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import { CommitTimeline } from './history/CommitTimeline';
import { HistoryCompareBar } from './history/HistoryCompareBar';
import type { CommitRowAction } from './history/CommitRow';
import type { CommitRowModel } from '@/lib/history/commitGraph';

interface HistoryPanelProps {
  onClose?: () => void;
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="p-3 text-xs text-muted-foreground">{children}</div>;
}

export function HistoryPanel({ onClose }: HistoryPanelProps) {
  const { t } = useTranslation();
  const locale = getLocale();

  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const focusModelId = useViewerStore((s) => s.historyFocusModelId);
  const commitTags = useViewerStore((s) => s.commitTags);
  const pickA = useViewerStore((s) => s.historyPickA);
  const pickB = useViewerStore((s) => s.historyPickB);
  const newHead = useViewerStore((s) => s.historyNewHeads);
  const setHistoryFocus = useViewerStore((s) => s.setHistoryFocus);
  const pickCommit = useViewerStore((s) => s.pickCommit);

  // The panel follows the active model until the user pins it elsewhere
  // (a row menu, the properties card). `historyFocusModelId` wins when the
  // model it names is still loaded.
  const modelId = focusModelId && models.has(focusModelId) ? focusModelId : activeModelId;
  const model = modelId ? models.get(modelId) ?? null : null;
  const history = useModelHistory(modelId);
  const loadedCommitId = modelId ? commitTags.get(modelId)?.commitId : undefined;

  useCommitWatch(history.kind === 'commit');

  const { openCommit } = useCommitLoad();
  const { showInViewport } = useShowCommitsIn3D();
  const { runComparison } = useCompare();

  const rows = useMemo(
    () =>
      buildCommitRows({
        commits: history.commits,
        headCommitId: history.model?.headCommitId ?? history.commits[0]?.id ?? '',
        ...(loadedCommitId !== undefined ? { loadedCommitId } : {}),
      }),
    [history.commits, history.model, loadedCommitId],
  );

  const refFor = useCallback(
    (commit: SourceCommit): CommitRef | null =>
      history.model
        ? { projectId: history.model.projectId, modelId: history.model.id, commitId: commit.id }
        : null,
    [history.model],
  );

  const commitFor = useCallback(
    (ref: CommitRef | null): SourceCommit | null =>
      ref ? history.commits.find((commit) => commit.id === ref.commitId) ?? null : null,
    [history.commits],
  );

  const compare = useCommitCompare(modelId, pickA, pickB);

  const handleAction = useCallback(
    (action: CommitRowAction, row: CommitRowModel) => {
      if (!modelId || !history.model) return;
      const ref = refFor(row.commit);
      if (!ref) return;
      const headCommitId = history.model.headCommitId;

      switch (action) {
        case 'open':
        case 'open-alongside':
          void openCommit({
            modelId,
            ref,
            commit: row.commit,
            mode: action === 'open' ? 'replace' : 'alongside',
            headCommitId,
            ...(action === 'open-alongside'
              ? { displayName: commitModelDisplayName(model?.name ?? history.model.name, row.commit, locale) }
              : {}),
          });
          return;
        case 'set-a':
          pickCommit('A', ref);
          return;
        case 'set-b':
          pickCommit('B', ref);
          return;
        case 'compare-with-loaded': {
          const loaded = history.commits.find((commit) => commit.id === loadedCommitId);
          if (!loaded) {
            toast.error('Open a version of this model first.');
            return;
          }
          // Ordered by time, not by which one was clicked — a diff reads
          // base → head, and the reversed pair would report every addition
          // as a deletion.
          const { base, head } = orderCompareSlots(row.commit, loaded);
          pickCommit('A', refFor(base));
          pickCommit('B', refFor(head));
          return;
        }
        case 'copy-id':
          void navigator.clipboard?.writeText(row.commit.id).then(
            () => toast.success(t('history.action.copied')),
            () => toast.error('Could not copy the commit id.'),
          );
          return;
      }
    },
    [modelId, history.model, history.commits, refFor, openCommit, model, locale, pickCommit, loadedCommitId, t],
  );

  const handleShowIn3D = useCallback(() => {
    if (!modelId || !history.model || !pickA || !pickB) return;
    const a = commitFor(pickA);
    const b = commitFor(pickB);
    if (!a || !b) return;
    const { base, head } = orderCompareSlots(a, b);
    void showInViewport({
      modelId,
      modelName: model?.name ?? history.model.name,
      base: { ref: { ...pickA, commitId: base.id }, commit: base },
      head: { ref: { ...pickB, commitId: head.id }, commit: head },
      headCommitId: history.model.headCommitId,
      runComparison,
    });
  }, [modelId, history.model, pickA, pickB, commitFor, showInViewport, model, runComparison]);

  const header = (
    <div className="flex items-center gap-2 border-b p-3">
      <History className="h-4 w-4 text-muted-foreground" />
      <span className="flex-1 truncate text-sm font-medium">{t('history.panel.title')}</span>
      {onClose && (
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} title={t('history.panel.close')}>
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (!modelId || !model) {
    body = <Message>{t('history.state.noModel')}</Message>;
  } else if (history.kind === 'no-source') {
    body = <Message>{t('history.state.noSource')}</Message>;
  } else if (history.kind === 'none') {
    // The model IS from a source; the source has no history to show. Dalux is
    // the reference case — its API can fetch a revision you already have an id
    // for and has no endpoint that lists them — and telling that user to
    // "open it from a source" would be advice they have already followed.
    body = <Message>{t('history.state.noProviderHistory')}</Message>;
  } else if (history.errorCode === 'forbidden') {
    body = <Message>{t('history.state.forbidden')}</Message>;
  } else if (history.error) {
    body = (
      <div role="alert" className="p-3 text-xs">
        <div className="text-destructive">{history.error}</div>
        <Button variant="secondary" size="sm" className="mt-2 h-6 text-[11px]" onClick={history.reload}>
          {t('history.state.retry')}
        </Button>
      </div>
    );
  } else if (history.loading && history.commits.length === 0) {
    body = <Message>{t('history.state.loading')}</Message>;
  } else if (history.commits.length === 0) {
    body = <Message>{t('history.state.empty')}</Message>;
  } else {
    body = (
      <>
        <HistoryCompareBar
          a={commitFor(pickA)}
          b={commitFor(pickB)}
          compare={compare}
          onClearSlot={(slot) => pickCommit(slot, null)}
          onShowIn3D={handleShowIn3D}
          showing3D={false}
        />
        <CommitTimeline
          rows={rows}
          canOpen={history.canOpenHistorical}
          hasMore={history.hasMore}
          loadingMore={history.loading}
          onAction={handleAction}
          onLoadMore={history.loadMore}
        />
      </>
    );
  }

  const pendingHead = modelId ? newHead.get(modelId) : undefined;

  return (
    <div className="flex h-full flex-col">
      {header}
      {model && (
        <div className="border-b px-3 py-2 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t('history.panel.modelLabel')}</span>
            <select
              className="min-w-0 flex-1 truncate rounded border bg-background px-1 py-0.5"
              value={modelId ?? ''}
              onChange={(event) => setHistoryFocus(event.target.value)}
              aria-label={t('history.panel.modelLabel')}
            >
              {[...models.values()].map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>
          {history.model && (
            <div className="mt-0.5 truncate text-muted-foreground">
              {t('history.panel.sourceLabel')} · {history.model.name}
            </div>
          )}
          {pendingHead && (
            <div className="mt-1 flex items-center gap-2 rounded bg-amber-500/10 px-1.5 py-1">
              <span className="flex-1 text-amber-700 dark:text-amber-400">{t('history.newHead.available')}</span>
              <button
                type="button"
                className="shrink-0 underline"
                onClick={() => {
                  const commit = history.commits.find((candidate) => candidate.id === pendingHead);
                  const ref = commit ? refFor(commit) : null;
                  if (!commit || !ref || !modelId) {
                    history.reload();
                    return;
                  }
                  void openCommit({ modelId, ref, commit, mode: 'replace', headCommitId: pendingHead });
                }}
              >
                {t('history.newHead.open')}
              </button>
            </div>
          )}
        </div>
      )}
      {body}
    </div>
  );
}
