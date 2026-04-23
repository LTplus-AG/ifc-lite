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

export interface GanttDragTooltipProps {
  live: {
    taskGlobalId: string | null;
    mode: 'shift' | 'resize-start' | 'resize-finish' | null;
    liveStartMs: number;
    liveFinishMs: number;
  };
}

export function GanttDragTooltip({ live }: GanttDragTooltipProps) {
  const durMs = Math.max(0, live.liveFinishMs - live.liveStartMs);
  const durDays = (durMs / 86_400_000).toFixed(2).replace(/\.?0+$/, '');
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const modeLabel =
    live.mode === 'shift' ? 'Shifting'
    : live.mode === 'resize-start' ? 'Resizing start'
    : live.mode === 'resize-finish' ? 'Resizing finish'
    : '';
  return (
    <div
      className="fixed z-50 pointer-events-none top-16 left-1/2 -translate-x-1/2 rounded-md border border-sky-400 bg-sky-50 dark:bg-sky-950 dark:border-sky-700 px-3 py-1.5 shadow-lg text-[11px] font-mono text-sky-900 dark:text-sky-100"
      role="status"
      aria-live="polite"
    >
      <div className="font-sans text-[10px] uppercase tracking-wider opacity-70">{modeLabel}</div>
      <div>Start  {fmt(live.liveStartMs)}</div>
      <div>Finish {fmt(live.liveFinishMs)}</div>
      <div className="opacity-80">Duration {durDays}d</div>
      <div className="font-sans text-[9px] opacity-50 mt-0.5">Shift = no snap · Esc = cancel</div>
    </div>
  );
}
