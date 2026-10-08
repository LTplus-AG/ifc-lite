/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Lens } from '@ifc-lite/lens';
import type { ListDefinition } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { sameReportEvidence } from '../flow/report-provenance.js';
import { loadSavedFilters, saveFilter, __internal, type SavedFilterPreset } from '../search/saved-filters.js';
import type { StandaloneArtifactLibraries } from './artifact-backup.js';

type Kind = keyof StandaloneArtifactLibraries;
export interface ArtifactImportOutcome { saved: number; failed: Kind[] }
function evidence(value: object): unknown {
  const { id: _id, name: _name, createdAt: _createdAt, updatedAt: _updatedAt, builtin: _builtin,
    ...fields } = value as Record<string, unknown>;
  return fields;
}
function copyName(name: string, index: number, limit = 200): string {
  const suffix = index === 1 ? ' (imported)' : ` (imported ${index})`;
  return name.slice(0, Math.max(1, limit - suffix.length)) + suffix;
}
/** Repeated native retries recognize an unchanged imported copy; edits are never overwritten. */
function reusable<T extends { name: string }>(rows: readonly T[], incoming: T, limit = 200): boolean {
  const names = new Set([incoming.name, ...Array.from({ length: rows.length + 1 }, (_, index) => copyName(incoming.name, index + 1, limit))]);
  const wanted = evidence(incoming);
  return rows.some(row => names.has(row.name) && sameReportEvidence(evidence(row), wanted));
}
function uniqueName(rows: readonly { name: string }[], name: string, limit = 200): string {
  const names = new Set(rows.map(row => row.name.toLowerCase()));
  if (!names.has(name.toLowerCase())) return name;
  for (let index = 1; index <= rows.length + 1; index++) {
    const candidate = copyName(name, index, limit);
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('An independent imported artifact name could not be allocated');
}
export function importArtifactLibraries(incoming: StandaloneArtifactLibraries): ArtifactImportOutcome {
  const outcome: ArtifactImportOutcome = { saved: 0, failed: [] };
  if (incoming.filters) {
    let rows = loadSavedFilters();
    for (const entry of incoming.filters) {
      if (reusable<SavedFilterPreset>(rows, entry, __internal.MAX_NAME_LEN)) continue;
      if (rows.length >= __internal.MAX_ENTRIES) { outcome.failed.push('filters'); break; }
      const result = saveFilter(uniqueName(rows, entry.name, __internal.MAX_NAME_LEN), entry.groups, entry.capturedScope);
      if (!result.persisted) { outcome.failed.push('filters'); break; }
      rows = result.presets; outcome.saved++;
    }
  }
  if (incoming.lists) {
    const state = useViewerStore.getState(), rows: ListDefinition[] = [...state.listDefinitions];
    let count = 0;
    for (const entry of incoming.lists) {
      if (reusable(rows, entry)) continue;
      rows.push({ ...entry, id: rows.some(row => row.id === entry.id) ? crypto.randomUUID() : entry.id,
        name: uniqueName(rows, entry.name) }); count++;
    }
    if (count && !state.setListDefinitions(rows)) outcome.failed.push('lists');
    else outcome.saved += count;
  }
  if (incoming.lenses) {
    const state = useViewerStore.getState(), rows: Lens[] = [...state.savedLenses], copies: Lens[] = [];
    for (const entry of incoming.lenses) {
      if (reusable(rows, entry)) continue;
      const copy = { ...entry, id: rows.some(row => row.id === entry.id) ? crypto.randomUUID() : entry.id,
        name: uniqueName(rows, entry.name), builtin: false };
      copies.push(copy); rows.push(copy);
    }
    if (copies.length && !state.importLenses(copies).ok) outcome.failed.push('lenses');
    else outcome.saved += copies.length;
  }
  return outcome;
}
