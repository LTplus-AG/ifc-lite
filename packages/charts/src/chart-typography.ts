/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Base chart text size; existing relative sizes (titles, print legends, KPI) keep their hierarchy. */
export const CHART_FONT_SIZE = { min: 6, max: 24, default: 12 } as const;

/** Shared text/layout scale; unset or invalid input preserves the existing chart typography (#6546). */
export function chartFontScale(fontSize?: number): number {
  return typeof fontSize === 'number' && Number.isFinite(fontSize)
    && fontSize >= CHART_FONT_SIZE.min && fontSize <= CHART_FONT_SIZE.max
    ? fontSize / CHART_FONT_SIZE.default : 1;
}
