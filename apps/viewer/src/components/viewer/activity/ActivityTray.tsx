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

import { useState, type ReactNode } from 'react';
import { Activity, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import { clearFinishedActivity } from '@/lib/activity/activity-journal';
import { StatusChip } from '../result/StatusChip';
import { useActivityRows, type ActivityRow } from './useActivityRows';

function JobRow({ row, onOpen }: { row: ActivityRow; onOpen: (row: ActivityRow) => void }) {
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
          <span className="inline-flex items-center gap-0.5"><Database className="h-3 w-3" aria-hidden="true" />{t('activityTray.persistent')}</span>
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

/** The tray's list, usable on its own (a popover on desktop, a dialog on phones). */
function ActivityTrayList({ onOpened, title }: { onOpened?: () => void; title?: ReactNode }) {
  const { t } = useTranslation();
  const rows = useActivityRows();
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
          <Button variant="ghost" size="sm" className="h-6 px-2 text-2xs" onClick={clearFinishedActivity}>
            {t('activityTray.clearFinished')}
          </Button>
        )}
      </div>
      {rows.length === 0
        ? <p className="px-3 py-4 text-xs text-muted-foreground">{t('activityTray.empty')}</p>
        : (
          <ul aria-label={t('activityTray.list')} className="overflow-y-auto">
            {rows.map((row) => <JobRow key={row.id} row={row} onOpen={open} />)}
          </ul>
        )}
    </section>
  );
}

export function ActivityTrayButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rows = useActivityRows();
  const running = rows.filter((row) => row.status === 'running').length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={running > 0 ? t('activityTray.buttonRunning', { count: running }) : t('activityTray.button')}
          className={cn(
            'relative flex items-center gap-1.5 rounded px-1 -mx-1 transition-colors hover:text-foreground after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-[\'\'] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            (open || running > 0) && 'text-foreground',
          )}
        >
          <Activity className={cn('h-3.5 w-3.5', running > 0 && 'text-primary')} aria-hidden="true" />
          <span>{t('activityTray.button')}</span>
          {running > 0 && <span className="tabular-nums">{running}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 p-0">
        <ActivityTrayList onOpened={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Phones have no status bar: the overflow menu opens the same list in a dialog. */
export function ActivityTrayDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-sm gap-0 p-0">
        <ActivityTrayList
          onOpened={() => onOpenChange(false)}
          title={<DialogTitle className="flex-1 text-xs font-semibold">{t('activityTray.title')}</DialogTitle>}
        />
      </DialogContent>
    </Dialog>
  );
}
