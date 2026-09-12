/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved dashboards, like saved lists: localStorage, validated on the way in so
 * a hand-edited or stale entry is dropped with a warning instead of crashing
 * the panel (#3944).
 */
import { validateDashboardSpec, type DashboardSpec } from '@ifc-lite/charts';

const STORAGE_KEY = 'ifc-lite-dashboards';

export function loadDashboards(): DashboardSpec[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const kept: DashboardSpec[] = [];
    for (const entry of parsed) {
      const errors = validateDashboardSpec(entry);
      if (errors.length === 0) kept.push(entry as DashboardSpec);
      else console.warn('[Charts] Dropping an invalid saved dashboard', errors);
    }
    return kept;
  } catch (err) {
    console.warn('[Charts] Failed to load saved dashboards', err);
    return [];
  }
}

export function saveDashboards(dashboards: readonly DashboardSpec[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dashboards));
  } catch (err) {
    console.warn('[Charts] Failed to save dashboards to localStorage', err);
  }
}
