/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved dashboards, like saved lists: localStorage, validated on the way in so
 * a hand-edited or stale entry is dropped with a warning instead of crashing
 * the panel; and the `.ifclite-dashboard.json` file a dashboard is shared as
 * (#3944).
 */
import { validateDashboardSpec, type DashboardSpec } from '@ifc-lite/charts';
import { downloadFile, sanitizeFilename } from '../export/download.js';

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

/** The file a dashboard is shared as. */
export const DASHBOARD_FILE_SUFFIX = '.ifclite-dashboard.json';

export function exportDashboard(dashboard: DashboardSpec): void {
  downloadFile(JSON.stringify(dashboard, null, 2), `${sanitizeFilename(dashboard.name, { fallback: 'dashboard' })}${DASHBOARD_FILE_SUFFIX}`, 'application/json');
}

/**
 * Parse a dashboard file. Validated structurally, and re-identified: the
 * imported copy gets fresh ids so it never collides with the dashboard it was
 * exported from (or with itself, imported twice). Chart ids are remapped in
 * the layout too, so the positions survive.
 */
export function parseDashboardFile(text: string): DashboardSpec {
  const parsed: unknown = JSON.parse(text);
  const errors = validateDashboardSpec(parsed);
  if (errors.length > 0) {
    throw new Error(`Not a dashboard file: ${errors.slice(0, 3).map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
  }
  const spec = parsed as DashboardSpec;
  const chartIds = new Map(spec.charts.map((c) => [c.id, `chart-${crypto.randomUUID()}`]));
  return {
    ...spec,
    id: `dashboard-${crypto.randomUUID()}`,
    charts: spec.charts.map((c) => ({ ...c, id: chartIds.get(c.id) ?? c.id })),
    layout: spec.layout.map((l) => ({ ...l, chartId: chartIds.get(l.chartId) ?? l.chartId })),
  };
}

export function importDashboard(file: File): Promise<DashboardSpec> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseDashboardFile(reader.result as string));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Failed to parse the dashboard file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read the dashboard file'));
    reader.readAsText(file);
  });
}
