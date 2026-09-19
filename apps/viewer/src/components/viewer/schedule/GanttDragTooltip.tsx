/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttDragTooltip — floating readout pinned near the top of the timeline
 * during a bar drag. Shows the proposed new start / finish / duration so
 * the user can see the commit target without staring at the bar itself.
 * Fixed positioning (not absolute) keeps it above any scroll; `top-16`
 * anchors below the toolbar region.
 */

import { useTranslation } from '@/i18n';
import { formatLocaleDate, formatLocaleNumber } from '@/i18n/intlFormat';

export interface GanttDragTooltipProps {
  live: {
    taskGlobalId: string | null;
    mode: 'shift' | 'resize-start' | 'resize-finish' | null;
    liveStartMs: number;
    liveFinishMs: number;
  };
}

export function GanttDragTooltip({ live }: GanttDragTooltipProps) {
  const { t, locale } = useTranslation();
  const durMs = Math.max(0, live.liveFinishMs - live.liveStartMs);
  const durDays = formatLocaleNumber(locale, durMs / 86_400_000, { maximumFractionDigits: 2 });
  const fmt = (ms: number) => formatLocaleDate(locale, ms, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'UTC',
  });
  const modeLabel =
    live.mode === 'shift' ? t('schedule.dragTooltip.shifting')
    : live.mode === 'resize-start' ? t('schedule.dragTooltip.resizingStart')
    : live.mode === 'resize-finish' ? t('schedule.dragTooltip.resizingFinish')
    : '';
  return (
    <div
      className="fixed z-50 pointer-events-none top-16 left-1/2 -translate-x-1/2 rounded-md border border-sky-400 bg-sky-50 dark:bg-sky-950 dark:border-sky-700 px-3 py-1.5 shadow-lg text-[11px] font-mono text-sky-900 dark:text-sky-100"
      role="status"
      aria-live="polite"
    >
      <div className="font-sans text-[10px] uppercase tracking-wider opacity-70">{modeLabel}</div>
      <div>{t('schedule.dragTooltip.start', { value: fmt(live.liveStartMs) })}</div>
      <div>{t('schedule.dragTooltip.finish', { value: fmt(live.liveFinishMs) })}</div>
      <div className="opacity-80">{t('schedule.dragTooltip.duration', { days: durDays })}</div>
      <div className="font-sans text-[9px] opacity-50 mt-0.5">{t('schedule.dragTooltip.hint')}</div>
    </div>
  );
}
