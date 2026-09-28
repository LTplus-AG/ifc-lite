/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The commit chip on a model row: which version this model is, whether a
 * newer one has landed, and the way into the History panel.
 *
 * Amber for a past version, and it says so IN TEXT ("Past version"), not by
 * tint alone — that tint is the only on-screen sign that the model is
 * read-only, and a user who cannot see it would just find their edits
 * silently doing nothing.
 *
 * Renders nothing for a model with no commit tag, which is every locally
 * opened file.
 */

import { History } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { getLocale } from '@/i18n/registry';
import { useBackToLatest } from '@/hooks/history/useCommitLoad';
import { shortCommitId } from '@/lib/history/commitLabels';
import { formatLocaleDate } from '@/i18n/intlFormat';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';

export interface ModelCommitBadgeProps {
  readonly modelId: string;
}

export function ModelCommitBadge({ modelId }: ModelCommitBadgeProps) {
  const { t } = useTranslation();
  const tag = useViewerStore((s) => s.commitTags.get(modelId));
  const newHead = useViewerStore((s) => s.historyNewHeads.get(modelId));
  const showPanel = useViewerStore((s) => s.showWorkspacePanel);
  const setHistoryFocus = useViewerStore((s) => s.setHistoryFocus);
  const backToLatest = useBackToLatest();

  if (!tag) return null;
  const loadedOn = formatLocaleDate(getLocale(), tag.loadedAt, { day: 'numeric', month: 'short' });

  return (
    <span className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setHistoryFocus(modelId);
              showPanel('history');
            }}
            className={cn(
              'flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px]',
              tag.historical
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
            )}
          >
            <History className="h-3 w-3" />
            <span>{shortCommitId(tag.commitId)}</span>
            {tag.historical && <span className="font-sans">{t('history.badge.historical')}</span>}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">
            {t('history.action.showHistory')} · {loadedOn}
          </p>
        </TooltipContent>
      </Tooltip>

      {(tag.historical || newHead) && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            backToLatest(modelId);
          }}
          className="rounded px-1 py-0.5 text-[10px] underline decoration-dotted"
          title={t('history.action.backToLatest')}
        >
          {newHead ? t('history.newHead.open') : t('history.action.backToLatest')}
        </button>
      )}
    </span>
  );
}
