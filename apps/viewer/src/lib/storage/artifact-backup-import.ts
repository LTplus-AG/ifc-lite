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
interface ImportIdentityOwners {
  claimed: Set<string>;
  sourceIds: ReadonlySet<string>;
}
function identityOwners(incoming: readonly { id: string }[]): ImportIdentityOwners {
  return { claimed: new Set(), sourceIds: new Set(incoming.map(row => row.id)) };
}
function evidence(value: object): unknown {
  const { id: _id, name: _name, createdAt: _createdAt, updatedAt: _updatedAt, builtin: _builtin,
    ...fields } = value as Record<string, unknown>;
  return fields;
}
function copyName(name: string, index: number, limit = 200): string {
  const suffix = index === 1 ? ' (imported)' : ` (imported ${index})`;
  return name.slice(0, Math.max(1, limit - suffix.length)) + suffix;
}
/** Filters use native names as identities; List/Lens provenance requires IDs. */
function reusableFilter(rows: readonly SavedFilterPreset[], incoming: SavedFilterPreset): boolean {
  return rows.some(row => (row.name === incoming.name || Array.from({ length: rows.length + 1 },
    (_, index) => copyName(incoming.name, index + 1, __internal.MAX_NAME_LEN)).includes(row.name))
    && sameReportEvidence(evidence(row), evidence(incoming)));
}
/** Collision copies have deterministic native IDs. Only that exact source-ID
 * lineage can be reused; equal independent local definitions remain independent. */
function importIdentity<T extends { id: string; name: string }>(rows: readonly T[], incoming: T,
  owners: ImportIdentityOwners): { id: string; existing: boolean } {
  const matches = (row: T) => !owners.claimed.has(row.id)
    && (row.name === incoming.name || Array.from({ length: rows.length + 1 },
      (_, index) => copyName(incoming.name, index + 1)).includes(row.name))
    && sameReportEvidence(evidence(row), evidence(incoming));
  const original = rows.find(row => row.id === incoming.id);
  if (!original && !owners.claimed.has(incoming.id)) return { id: incoming.id, existing: false };
  if (original && matches(original)) return { id: original.id, existing: true };
  // At most rows+incoming+claimed IDs are reserved, so one further candidate
  // must be free. This also bounds adversarial source-ID collisions.
  const bound = rows.length + owners.sourceIds.size + owners.claimed.size + 1;
  for (let index = 1; index <= bound; index++) {
    const id = `ifc-lite-backup:${index}:${incoming.id}`;
    if (owners.sourceIds.has(id) || owners.claimed.has(id)) continue;
    const row = rows.find(candidate => candidate.id === id);
    if (!row) return { id, existing: false };
    if (matches(row)) return { id, existing: true };
  }
  throw new Error('An independent imported artifact identity could not be allocated');
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
      if (reusableFilter(rows, entry)) continue;
      if (rows.length >= __internal.MAX_ENTRIES) { outcome.failed.push('filters'); break; }
      const result = saveFilter(uniqueName(rows, entry.name, __internal.MAX_NAME_LEN), entry.groups, entry.capturedScope);
      if (!result.persisted) { outcome.failed.push('filters'); break; }
      rows = result.presets; outcome.saved++;
    }
  }
  if (incoming.lists) {
    const state = useViewerStore.getState(), rows: ListDefinition[] = [...state.listDefinitions];
    const owners = identityOwners(incoming.lists);
    let count = 0;
    for (const entry of incoming.lists) {
      const identity = importIdentity(rows, entry, owners);
      owners.claimed.add(identity.id);
      if (identity.existing) continue;
      const copy = { ...entry, id: identity.id,
        name: uniqueName(rows, entry.name) };
      rows.push(copy); count++;
    }
    // List CRUD can retain an unsaved session draft after quota refusal. Equal
    // rows do not prove durability; the native save must confirm every retry.
    if (incoming.lists.length && !state.setListDefinitions(rows)) outcome.failed.push('lists');
    else outcome.saved += count;
  }
  if (incoming.lenses) {
    const state = useViewerStore.getState(), rows: Lens[] = [...state.savedLenses], copies: Lens[] = [];
    const owners = identityOwners(incoming.lenses);
    for (const entry of incoming.lenses) {
      const identity = importIdentity(rows, entry, owners);
      owners.claimed.add(identity.id);
      if (identity.existing) continue;
      const copy = { ...entry, id: identity.id,
        name: uniqueName(rows, entry.name), builtin: false };
      copies.push(copy); rows.push(copy);
    }
    if (copies.length && !state.importLenses(copies).ok) outcome.failed.push('lenses');
    else outcome.saved += copies.length;
  }
  return outcome;
}
