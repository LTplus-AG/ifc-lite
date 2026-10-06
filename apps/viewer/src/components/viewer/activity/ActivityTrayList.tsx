/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one activity tray (U02, #6925; charter "Shared artifact editing"):
 * every user-initiated job in one list, opened from the status bar. Each row
 * shows what ran and on what, its phase, its outcome chip, Cancel where
 * the job's own source supports cancelling, and Open for the panel that owns
 * the job's artifact. BCF publication rows come from the durable outbox and
 * say so; ephemeral jobs cut off by a reload show as interrupted.
 */

/**
 * The activity tray's list body (U02, #6925), loaded on first open so the
 * status bar and phone menu ship only the trigger and the live region. The
 * trigger stays in `ActivityTray.tsx`; this module is the popover/dialog body.
 */

import type { ComponentType, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import type { ResultStatus } from '../result/status-labels';
import type { ActivityRow } from './useActivityRows';

type StatusChipComponent = ComponentType<{ status: ResultStatus }>;
type PersistentIconComponent = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

/** Components the always-loaded trigger already ships; see `ActivityTrayList`. */
interface SharedParts { StatusChip: StatusChipComponent; PersistentIcon: PersistentIconComponent }

function JobRow({ row, onOpen, StatusChip, PersistentIcon }: { row: ActivityRow; onOpen: (row: ActivityRow) => void } & SharedParts) {
  const { t, locale } = useTranslation();
  const title = t(row.titleKey);
  const number = (value: number) => formatLocaleNumber(locale, value);
  const time = row.at > 0 ? new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(row.at) : null;
  return (
    <li className="space-y-0.5 border-b border-border px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{title}</div>
          {row.subject && <div className="truncate text-2xs text-muted-foreground">{row.subject}</div>}
        </div>
        <StatusChip status={row.status} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
        {time && <time dateTime={new Date(row.at).toISOString()}>{time}</time>}
        {row.phase && <span className="truncate">{row.phase}</span>}
        {row.progress && <span className="tabular-nums">{t('activityTray.progress', { done: number(row.progress.done), total: number(row.progress.total) })}</span>}
        {row.publication && (
          <span className="tabular-nums">{t('activityTray.publication.effects', { done: number(row.publication.done), total: number(row.publication.total) })}</span>
        )}
        {row.persistent && (
          <span className="inline-flex items-center gap-0.5"><PersistentIcon className="h-3 w-3" aria-hidden="true" />{t('activityTray.persistent')}</span>
        )}
        {(row.cancel || row.panel) && (
          <span className="ml-auto flex gap-1">
            {row.cancel && (
              <Button variant="outline" size="sm" className="h-6 px-2 text-2xs" aria-label={t('activityTray.cancelLabel', { title })}
                onClick={row.cancel}>
                {t('activityTray.cancel')}
              </Button>
            )}
            {row.panel && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-2xs" aria-label={t('activityTray.openLabel', { title })}
                onClick={() => onOpen(row)}>
                {t('activityTray.open')}
              </Button>
            )}
          </span>
        )}
      </div>
      {(row.detailKey || row.detail) && (
        <p className={cn('text-2xs', row.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
          {row.detailKey ? t(row.detailKey, { count: row.detailCount ?? 0 }) : row.detail}
        </p>
      )}
    </li>
  );
}

/**
 * `StatusChip` and `PersistentIcon` are handed in by the always-loaded trigger,
 * which already ships them: a second importer here would split each into its
 * own chunk that the first paint then has to fetch.
 */
export default function ActivityTrayList({ rows, StatusChip, PersistentIcon, onClearFinished, onOpened, title }: SharedParts & {
  rows: readonly ActivityRow[];
  onClearFinished: () => void;
  onOpened?: () => void;
  title?: ReactNode;
}) {
  const { t } = useTranslation();
  const open = (row: ActivityRow) => {
    if (!row.panel) return;
    useViewerStore.getState().openWorkspacePanel(row.panel);
    onOpened?.();
  };
  const finished = rows.some((row) => !row.persistent && row.status !== 'running');
  return (
    <section aria-label={t('activityTray.title')} className="flex max-h-96 flex-col">
      {/* In the phone dialog, `title` is the dialog's own title; keep clear of its close button. */}
      <div className={cn('flex items-center gap-2 border-b border-border px-3 py-2', title && 'pr-10')}>
        {title ?? <h2 className="flex-1 text-xs font-semibold">{t('activityTray.title')}</h2>}
        {finished && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-2xs" onClick={onClearFinished}>
            {t('activityTray.clearFinished')}
          </Button>
        )}
      </div>
      {rows.length === 0
        ? <p className="px-3 py-4 text-xs text-muted-foreground">{t('activityTray.empty')}</p>
        : (
          <ul aria-label={t('activityTray.list')} className="overflow-y-auto">
            {rows.map((row) => <JobRow key={row.id} row={row} onOpen={open} StatusChip={StatusChip} PersistentIcon={PersistentIcon} />)}
          </ul>
        )}
    </section>
  );
}
