/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One commit in the timeline: rail marker, title, author and time, change
 * counts, badges, and the actions menu.
 *
 * Every badge carries TEXT. A tint alone would make "this is a past version"
 * invisible to a colour-blind user and to anyone reading a screenshot in
 * grayscale — and that particular fact is the one gating whether the model
 * can be edited.
 */

import { useCallback } from 'react';
import { GitMerge, MoreHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranslation } from '@/i18n';
import { getLocale } from '@/i18n/registry';
import type { CommitRowModel } from '@/lib/history/commitGraph';
import {
  absoluteCommitTime,
  commitStatsText,
  commitTitle,
  relativeCommitTime,
} from '@/lib/history/commitLabels';
import { cn } from '@/lib/utils';

export type CommitRowAction =
  | 'open'
  | 'open-alongside'
  | 'set-a'
  | 'set-b'
  | 'compare-with-loaded'
  | 'copy-id';

export interface CommitRowProps {
  readonly row: CommitRowModel;
  /** `false` disables the two open actions, with a tooltip saying why. */
  readonly canOpen: boolean;
  readonly onAction: (action: CommitRowAction, row: CommitRowModel) => void;
}

function Badge({ label, tone }: { label: string; tone: 'head' | 'loaded' | 'warn' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide',
        tone === 'head' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
        tone === 'loaded' && 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
        tone === 'warn' && 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
      )}
    >
      {label}
    </span>
  );
}

export function CommitRow({ row, canOpen, onAction }: CommitRowProps) {
  const { t } = useTranslation();
  const locale = getLocale();
  const { commit } = row;
  const stats = commitStatsText(commit);
  const handle = useCallback((action: CommitRowAction) => () => onAction(action, row), [onAction, row]);

  return (
    <div
      role="listitem"
      className={cn(
        'flex gap-2 border-b px-3 py-2 text-xs',
        row.isLoaded && 'bg-accent/40',
        !row.onMainline && 'opacity-70',
      )}
    >
      <div className="flex w-3 shrink-0 flex-col items-center pt-1" aria-hidden="true">
        {row.isMerge ? (
          <GitMerge className="h-3 w-3 text-muted-foreground" />
        ) : (
          <span className={cn('h-1.5 w-1.5 rounded-full', row.isHead ? 'bg-emerald-500' : 'bg-muted-foreground')} />
        )}
        <span className="mt-1 w-px flex-1 bg-border" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1.5">
          <span className="min-w-0 flex-1 truncate font-medium">{commitTitle(commit)}</span>
          {row.isHead && <Badge label={t('history.badge.head')} tone="head" />}
          {row.isLoaded && <Badge label={t('history.badge.loaded')} tone="loaded" />}
          {commit.status === 'pending' && <Badge label={t('history.badge.pending')} tone="warn" />}
          {commit.status === 'rejected' && <Badge label={t('history.badge.rejected')} tone="warn" />}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {commit.author?.displayName && <span className="truncate">{commit.author.displayName}</span>}
          <span title={absoluteCommitTime(commit, locale)}>{relativeCommitTime(commit, locale)}</span>
          {stats && commit.stats && (
            // The glyphs (`+12 ~48 −3`) are unreadable aloud, so the row
            // carries the same counts in words for a screen reader.
            <span
              className="ml-auto shrink-0 tabular-nums"
              title={t('history.row.stats', {
                added: commit.stats.added,
                modified: commit.stats.modified,
                deleted: commit.stats.deleted,
              })}
            >
              <span aria-hidden="true">{stats}</span>
              <span className="sr-only">
                {t('history.row.stats', {
                  added: commit.stats.added,
                  modified: commit.stats.modified,
                  deleted: commit.stats.deleted,
                })}
              </span>
            </span>
          )}
        </div>
        {row.isMerge && <div className="mt-0.5 text-[10px] text-muted-foreground">{t('history.timeline.mergeCommit')}</div>}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label={t('history.action.menu')}>
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-xs">
          <DropdownMenuItem
            disabled={!canOpen}
            onSelect={handle('open')}
            title={canOpen ? undefined : t('history.action.openDisabled')}
          >
            {t('history.action.open')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canOpen}
            onSelect={handle('open-alongside')}
            title={canOpen ? undefined : t('history.action.openDisabled')}
          >
            {t('history.action.openAlongside')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handle('set-a')}>{t('history.action.setA')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={handle('set-b')}>{t('history.action.setB')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={handle('compare-with-loaded')}>
            {t('history.action.compareWithLoaded')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handle('copy-id')}>{t('history.action.copyId')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
