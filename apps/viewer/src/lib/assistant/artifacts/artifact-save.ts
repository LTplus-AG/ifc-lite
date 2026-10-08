/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saving a reviewed artifact into its native library and opening the native
 * panel on it. Each goes through the library's own write path, so the item is
 * an ordinary user-editable entry from then on: saved filters
 * (`saveFilter`), Lists (`addListDefinition`), Lenses (`createLens`) and chart
 * dashboards (`upsertDashboard`). None of these native types carries an origin
 * field, so no assistant metadata is stored on them.
 *
 * Opening never applies anything to the scene by itself: a filter opens in the
 * search Filter tab and runs there (selection, isolation and export stay the
 * Filter tab's own buttons), a list opens in the list builder, a lens opens in
 * the native lens editor, and a chart opens in its dashboard's native editor.
 */

import { DASHBOARD_GRID_COLUMNS, type DashboardSpec } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import { loadSavedFilters, saveFilter } from '@/lib/search/saved-filters';
import type { PreviewArtifact } from './preview-shared';

export type SavedArtifact =
  | { kind: 'filter.proposal'; name: string }
  | { kind: 'list.proposal'; name: string; id: string }
  | { kind: 'lens.proposal'; name: string; id: string }
  | { kind: 'chart.proposal'; name: string; id: string; dashboardId: string; dashboardName: string };

/** Why a save did not happen, as a code the review card translates. */
export type SaveRefusal = 'already-saved' | 'storage';
export type SaveOutcome = { ok: true; saved: SavedArtifact } | { ok: false; reason: SaveRefusal };

/**
 * Filter reviews already saved. Saved filters carry no id to check, so the
 * review's own artifact is the identity: a second click on Save is refused
 * like the other kinds, while a new review of the same proposal saves anew.
 */
const savedFilterReviews = new WeakSet<PreviewArtifact>();

/** `name`, or `name (2)`, `name (3)`… — never overwrite an entry the user already has. */
export function uniqueName(name: string, taken: Iterable<string>, max = 80): string {
  const lower = new Set([...taken].map((item) => item.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, max - suffix.length)}${suffix}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`No free name for "${name}"`);
}

function saveChart(artifact: Extract<PreviewArtifact, { kind: 'chart.proposal' }>): SaveOutcome {
  const state = useViewerStore.getState();
  // A chart's numbers depend on its dashboard's scope, so it only joins a dashboard reviewed in the same scope.
  const active = state.dashboards.find((d) => d.id === state.activeDashboardId);
  const host: DashboardSpec = active && active.scope.kind === artifact.scope.kind
    ? active
    : { version: 2, id: `dashboard-${crypto.randomUUID()}`, name: uniqueName(artifact.spec.title, state.dashboards.map((d) => d.name)),
      scope: artifact.scope, charts: [], layout: [] };
  const y = host.layout.reduce((bottom, item) => Math.max(bottom, item.y + item.h), 0);
  const next: DashboardSpec = { ...host, charts: [...host.charts, artifact.spec],
    layout: [...host.layout, { chartId: artifact.spec.id, x: 0, y, w: Math.min(6, DASHBOARD_GRID_COLUMNS), h: 4 }] };
  state.upsertDashboard(next);
  return { ok: true, saved: { kind: 'chart.proposal', name: artifact.spec.title, id: artifact.spec.id, dashboardId: next.id, dashboardName: next.name } };
}

export function saveArtifact(artifact: PreviewArtifact): SaveOutcome {
  const state = useViewerStore.getState();
  switch (artifact.kind) {
    case 'filter.proposal': {
      if (savedFilterReviews.has(artifact)) return { ok: false, reason: 'already-saved' };
      const name = uniqueName(artifact.name, loadSavedFilters().map((preset) => preset.name));
      const { persisted } = saveFilter(name, artifact.groups, artifact.capturedScope);
      if (!persisted) return { ok: false, reason: 'storage' };
      savedFilterReviews.add(artifact);
      return { ok: true, saved: { kind: 'filter.proposal', name } };
    }
    case 'list.proposal': {
      if (state.listDefinitions.some((d) => d.id === artifact.definition.id)) return { ok: false, reason: 'already-saved' };
      const name = uniqueName(artifact.definition.name, state.listDefinitions.map((d) => d.name));
      state.addListDefinition({ ...artifact.definition, name });
      return { ok: true, saved: { kind: 'list.proposal', name, id: artifact.definition.id } };
    }
    case 'lens.proposal': {
      if (state.savedLenses.some((l) => l.id === artifact.lens.id)) return { ok: false, reason: 'already-saved' };
      const name = uniqueName(artifact.lens.name, state.savedLenses.map((l) => l.name));
      const result = state.createLens({ ...artifact.lens, name });
      if (result.ok) return { ok: true, saved: { kind: 'lens.proposal', name, id: artifact.lens.id } };
      console.warn('[Assistant] The lens library refused the reviewed lens', result.message);
      return { ok: false, reason: 'storage' };
    }
    case 'chart.proposal': {
      if (state.dashboards.some((d) => d.charts.some((c) => c.id === artifact.spec.id))) return { ok: false, reason: 'already-saved' };
      return saveChart(artifact);
    }
  }
}

/**
 * Load `groups` into the search Filter tab and run them there: the native
 * builder shows every rule for editing, and its own buttons select, isolate,
 * export or turn the result into a list. Only ever called from a click.
 */
export function openFilterInSearch(groups: PreviewArtifact & { kind: 'filter.proposal' }): void {
  const state = useViewerStore.getState();
  state.setSearchFilter({ groups: groups.groups, capturedScope: groups.capturedScope, limit: state.searchFilter.limit });
  state.setSearchModalTab('filter');
  state.setSearchFilterAutoRunPending(true);
  state.setSearchModalOpen(true);
}

/** Open the native panel focused on a saved artifact. Never selects, isolates or colours anything. */
export function openSavedArtifact(saved: SavedArtifact, artifact: PreviewArtifact): void {
  const state = useViewerStore.getState();
  switch (saved.kind) {
    case 'filter.proposal':
      if (artifact.kind === 'filter.proposal') openFilterInSearch(artifact);
      return;
    case 'list.proposal': {
      const definition = state.listDefinitions.find((d) => d.id === saved.id);
      if (definition) state.setPendingListDraft(definition);
      state.openPanelInHome('lists', 'context');
      return;
    }
    case 'lens.proposal':
      state.setPendingArtifactEditor({ kind: 'lens', id: saved.id });
      state.openPanelInHome('lens', 'context');
      return;
    case 'chart.proposal':
      state.setActiveDashboardId(saved.dashboardId);
      state.setPendingArtifactEditor({ kind: 'chart', id: saved.id, dashboardId: saved.dashboardId });
      state.openPanelInHome('charts', 'context');
      return;
  }
}
