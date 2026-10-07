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

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { statusLabelKey, type ResultStatus } from '../result/StatusChip';
import { useActivityRows } from './useActivityRows';

const ActivityTrayList = lazy(() => import('./ActivityTrayList').then(module => ({ default: module.ActivityTrayList })));

/**
 * Announces a session job that finishes while the viewer is open ("Export
 * (Export IFC): Failed") through one live region mounted with the tray's entry
 * point, so the outcome is heard without opening the tray. A job that was
 * already finished before mount, or comes back interrupted after a reload, is
 * not news and is not announced.
 */
function ActivityAnnouncer() {
  const { t } = useTranslation();
  const rows = useActivityRows();
  const mountedAt = useRef(Date.now());
  const seen = useRef<Map<string, ResultStatus> | null>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  useEffect(() => {
    const previous = seen.current;
    seen.current = new Map(rows.map((row) => [row.id, row.status]));
    if (!previous) return;
    // Seen running, or started and finished between two renders since mount. A
    // job restored from before a reload (finished or interrupted) is older than the mount.
    const finished = rows.filter((row) => !row.persistent && row.status !== 'running'
      && (previous.get(row.id) === 'running' || (!previous.has(row.id) && row.at >= mountedAt.current)));
    if (finished.length === 0) return;
    const text = finished.map((row) => t(row.subject ? 'activityTray.announceSubject' : 'activityTray.announce', {
      title: t(row.titleKey), subject: row.subject ?? '', status: t(statusLabelKey(row.status)),
    })).join(' ');
    setMessage((last) => ({ text, count: last.count + 1 }));
  }, [rows, t]);
  // An identical second message would not change the DOM, so it would not be read; alternate a trailing no-break space.
  return (
    <output aria-live="polite" data-activity-announcer className="sr-only">
      {message.text}{message.count % 2 === 1 ? '\u00a0' : ''}
    </output>
  );
}

export function ActivityTrayButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rows = useActivityRows();
  const running = rows.filter((row) => row.status === 'running').length;
  return (
    <>
      <ActivityAnnouncer />
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
          {open && <Suspense fallback={null}><ActivityTrayList onOpened={() => setOpen(false)} /></Suspense>}
        </PopoverContent>
      </Popover>
    </>
  );
}

/** Phones have no status bar: the overflow menu opens the same list in a dialog. */
export function ActivityTrayDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <>
      {/* Mounted with the overflow-menu entry, not the dialog, so it speaks while the tray is closed. */}
      <ActivityAnnouncer />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined} className="max-w-sm gap-0 p-0">
          {open && <Suspense fallback={null}><ActivityTrayList
            onOpened={() => onOpenChange(false)}
            title={<DialogTitle className="flex-1 text-xs font-semibold">{t('activityTray.title')}</DialogTitle>}
          /></Suspense>}
        </DialogContent>
      </Dialog>
    </>
  );
}
