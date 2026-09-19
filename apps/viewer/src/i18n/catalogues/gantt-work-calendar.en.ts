/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Gantt timeline's work-calendar toggle (#4830) — the small
 * `respectWorkCalendar` button `GanttTimeline.tsx` shows only when the
 * loaded file assigns an `IfcWorkCalendar`. Three strings: the button's own
 * aria-label, and its two tooltip variants (on/off).
 */
export const ganttWorkCalendarEn = {
  'gantt.workCalendar.toggle.ariaLabel': 'Respect work calendar',
  'gantt.workCalendar.toggle.tooltipOn':
    'Non-working days shaded, animation skips them — click to ignore the work calendar',
  'gantt.workCalendar.toggle.tooltipOff':
    'Work calendar ignored — click to shade non-working days and skip them during playback',
} as const;
