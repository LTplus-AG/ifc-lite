/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ListDefinition } from '@ifc-lite/lists';
import type { Lens } from '@ifc-lite/lens';
import { decodeSavedFilter, encodeSavedFilter, type SavedFilterPreset } from '../search/saved-filters.js';
import { decodeSavedList, encodeSavedList } from '../lists/saved-list-codec.js';
import { migrateSavedLens, encodeSavedLens } from '../lens/migrate-saved-lens.js';

export interface StandaloneArtifactLibraries {
  filters?: SavedFilterPreset[];
  lists?: ListDefinition[];
  lenses?: Lens[];
}

/** Native artifact codecs own their versions; backup never reinterprets their criteria. */
export function encodeArtifactLibraries(libraries: StandaloneArtifactLibraries): Record<string, unknown> {
  return {
    ...(libraries.filters ? { filters: libraries.filters.map(encodeSavedFilter) } : {}),
    ...(libraries.lists ? { lists: libraries.lists.map(encodeSavedList) } : {}),
    ...(libraries.lenses ? { lenses: libraries.lenses.map(encodeSavedLens) } : {}),
  };
}
export function decodeArtifactLibraries(raw: Record<string, unknown>): StandaloneArtifactLibraries {
  const array = (kind: string): unknown[] | undefined => {
    if (raw[kind] === undefined) return undefined;
    if (!Array.isArray(raw[kind])) throw new Error(`Invalid ${kind} artifact library backup`);
    return raw[kind];
  };
  const filters = array('filters')?.map(value => {
    if (!value || typeof value !== 'object' || !('schemaVersion' in value)
      || (value.schemaVersion !== 2 && value.schemaVersion !== 3)) {
      throw new Error('Invalid or unsupported saved filter in library backup');
    }
    const preset = decodeSavedFilter(value);
    if (!preset) throw new Error('Invalid or unsupported saved filter in library backup');
    return preset;
  });
  const lists = array('lists')?.map(value => decodeSavedList(value));
  const lenses = array('lenses')?.map(value => {
    const lens = migrateSavedLens(value);
    if (!lens?.id) throw new Error('Invalid or unsupported saved lens in library backup');
    return { ...lens, id: lens.id, builtin: false };
  });
  const unique = (values: string[] | undefined, kind: string) => {
    if (values && new Set(values).size !== values.length) throw new Error(`Duplicate ${kind} in library backup`);
  };
  unique(filters?.map(row => row.name.toLowerCase()), 'filter names');
  unique(lists?.map(row => row.id), 'list IDs');
  unique(lenses?.map(row => row.id), 'lens IDs');
  return { ...(filters ? { filters } : {}), ...(lists ? { lists } : {}), ...(lenses ? { lenses } : {}) };
}
