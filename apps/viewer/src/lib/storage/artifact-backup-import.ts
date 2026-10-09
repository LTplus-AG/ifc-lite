/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Lens } from '@ifc-lite/lens';
import type { ListDefinition } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { sameReportEvidence } from '../flow/report-provenance.js';
import { loadSavedFilters, saveFilter, __internal, type SavedFilterPreset } from '../search/saved-filters.js';
import { loadListDefinitions } from '../lists/persistence.js';
import { buildInitialLenses, AUTO_COLOR_FROM_LIST_ID } from '@/store/slices/lensSlice';
import { encodeSavedLens, migrateSavedLens } from '../lens/migrate-saved-lens.js';
import { encodeSavedList } from '../lists/saved-list-codec.js';
import type { StandaloneArtifactLibraries } from './artifact-backup.js';

type Kind = keyof StandaloneArtifactLibraries;
export interface ArtifactImportOutcome { saved: number; failed: Kind[]; pending: StandaloneArtifactLibraries }
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
/** Include newly durable peer-tab rows without overwriting a conflicting local draft. */
function currentRows<T extends { id: string }>(saved: T[], local: T[], encode: (row: T) => unknown, kind: string): T[] {
  const rows = new Map(saved.map(row => [row.id, row]));
  for (const row of local) {
    const durable = rows.get(row.id);
    if (durable && !sameReportEvidence(encode(durable), encode(row))) {
      throw new Error(`${kind} changed in another tab. Reload the library before backing up or importing.`);
    }
    if (!durable) rows.set(row.id, row);
  }
  return [...rows.values()];
}
export function currentListDefinitions(): ListDefinition[] {
  return currentRows(loadListDefinitions(), useViewerStore.getState().listDefinitions, encodeSavedList, 'Lists');
}
export function currentLensDefinitions(): Lens[] {
  return currentRows(buildInitialLenses(), useViewerStore.getState().savedLenses, row => {
    const normalized = migrateSavedLens(encodeSavedLens(row));
    if (!normalized) throw new Error('A saved Lens is unreadable. Export its original before refreshing the library.');
    return normalized;
  }, 'Lenses')
    .filter(row => row.id !== AUTO_COLOR_FROM_LIST_ID);
}
/** Filters use native names as identities; List/Lens provenance requires IDs. */
function reusableFilter(rows: readonly SavedFilterPreset[], incoming: SavedFilterPreset): boolean {
  const identity = incoming.name.trim().toLowerCase();
  return rows.some(row => row.name.trim().toLowerCase() === identity
    && sameReportEvidence(evidence(row), evidence(incoming)));
}
/** Collision copies have deterministic native IDs. Only that exact source-ID
 * lineage can be reused; equal independent local definitions remain independent. */
function importIdentity<T extends { id: string; name: string }>(rows: readonly T[], incoming: T,
  owners: ImportIdentityOwners): { id: string; name: string; existing: boolean } {
  const matches = (row: T, name: string) => !owners.claimed.has(row.id)
    && row.name === name && sameReportEvidence(evidence(row), evidence(incoming));
  const original = rows.find(row => row.id === incoming.id);
  if (!original && !owners.claimed.has(incoming.id)) return { id: incoming.id, name: incoming.name, existing: false };
  if (original && matches(original, incoming.name)) return { id: original.id, name: original.name, existing: true };
  // At most rows+incoming+claimed IDs are reserved, so one further candidate
  // must be free. This also bounds adversarial source-ID collisions.
  const bound = rows.length + owners.sourceIds.size + owners.claimed.size + 1;
  for (let index = 1; index <= bound; index++) {
    const id = `ifc-lite-backup:${index}:${incoming.id}`;
    if (owners.sourceIds.has(id) || owners.claimed.has(id)) continue;
    const row = rows.find(candidate => candidate.id === id);
    const name = copyName(incoming.name, index);
    if (!row) return { id, name, existing: false };
    if (matches(row, name)) return { id, name, existing: true };
  }
  throw new Error('An independent imported artifact identity could not be allocated');
}
function uniqueName(rows: readonly { name: string }[], name: string, limit = 200, reserved: ReadonlySet<string> = new Set()): string {
  const names = new Set(rows.map(row => row.name.toLowerCase()));
  if (!names.has(name.toLowerCase())) return name;
  for (let index = 1; index <= rows.length + reserved.size + 1; index++) {
    const candidate = copyName(name, index, limit);
    if (!names.has(candidate.toLowerCase()) && !reserved.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('An independent imported artifact name could not be allocated');
}
export function importArtifactLibraries(incoming: StandaloneArtifactLibraries): ArtifactImportOutcome {
  const outcome: ArtifactImportOutcome = { saved: 0, failed: [], pending: {} };
  if (incoming.filters) {
    let rows = loadSavedFilters();
    const sourceNames = new Set(incoming.filters.map(row => row.name.trim().toLowerCase()));
    for (const [index, entry] of incoming.filters.entries()) {
      if (reusableFilter(rows, entry)) continue;
      if (rows.length >= __internal.MAX_ENTRIES) {
        outcome.failed.push('filters'); outcome.pending.filters = incoming.filters.slice(index); break;
      }
      const result = saveFilter(uniqueName(rows, entry.name, __internal.MAX_NAME_LEN, sourceNames), entry.groups, entry.capturedScope);
      if (!result.persisted) {
        outcome.failed.push('filters'); outcome.pending.filters = incoming.filters.slice(index); break;
      }
      rows = result.presets; outcome.saved++;
    }
  }
  if (incoming.lists) {
    const state = useViewerStore.getState(), rows: ListDefinition[] = currentListDefinitions();
    const owners = identityOwners(incoming.lists);
    let count = 0;
    for (const entry of incoming.lists) {
      const identity = importIdentity(rows, entry, owners);
      owners.claimed.add(identity.id);
      if (identity.existing) continue;
      const copy = { ...entry, id: identity.id,
        name: identity.name };
      rows.push(copy); count++;
    }
    // List CRUD can retain an unsaved session draft after quota refusal. Equal
    // rows do not prove durability; the native save must confirm every retry.
    if (incoming.lists.length && !state.setListDefinitions(rows)) {
      outcome.failed.push('lists'); outcome.pending.lists = incoming.lists;
    }
    else outcome.saved += count;
  }
  if (incoming.lenses) {
    const state = useViewerStore.getState(), rows = currentLensDefinitions();
    const copies = rows.filter(row => !state.savedLenses.some(local => local.id === row.id));
    let count = 0;
    const owners = identityOwners(incoming.lenses);
    for (const entry of incoming.lenses) {
      const identity = importIdentity(rows, entry, owners);
      owners.claimed.add(identity.id);
      if (identity.existing) continue;
      const copy = { ...entry, id: identity.id,
        name: identity.name, builtin: false };
      copies.push(copy); rows.push(copy); count++;
    }
    if (incoming.lenses.length && !state.importLenses(copies).ok) {
      outcome.failed.push('lenses'); outcome.pending.lenses = incoming.lenses;
    }
    else outcome.saved += count;
  }
  return outcome;
}
