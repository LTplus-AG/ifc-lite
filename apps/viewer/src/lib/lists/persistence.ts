/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistence for list definitions via localStorage
 */

import { trackExportCompleted } from '@/lib/analytics';
import { type ListDefinition } from '@ifc-lite/lists';
import { downloadFile, sanitizeFilename } from '../export/download.js';

import { decodeSavedList, encodeSavedList } from './saved-list-codec.js';

const STORAGE_KEY = 'ifc-lite-lists';

export function loadListDefinitions(): ListDefinition[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited or half-written entry can be valid JSON that isn't an
    // array (an object, a stray number, `null`...). `listSlice` spreads this
    // result (`[...listDefinitions, def]`) on the very first list the user
    // creates, so anything non-array here throws "is not iterable" and
    // bricks the List panel at boot instead of just starting empty.
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((definition: unknown) => {
      if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
        console.warn('[Lists] Skipping a malformed saved list entry');
        return [];
      }
      try {
        return [decodeSavedList(definition)];
      } catch (error) {
        console.warn('[Lists] Skipping a saved list that could not be migrated', error);
        return [];
      }
    });
  } catch (error) {
    console.warn('[Lists] Failed to read list definitions from localStorage', error);
    return [];
  }
}

export function saveListDefinitions(definitions: ListDefinition[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(definitions.map(encodeSavedList)));
  } catch {
    console.warn('[Lists] Failed to save list definitions to localStorage');
  }
}

export function exportListDefinition(definition: ListDefinition): void {
  const json = JSON.stringify(encodeSavedList(definition), null, 2);
  const name = sanitizeFilename(definition.name, { fallback: 'list' });
  downloadFile(json, `${name}.list.json`, 'application/json');
  trackExportCompleted({ format: 'json', surface: 'list_results' });
}

export function importListDefinition(file: File): Promise<ListDefinition> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw: unknown = JSON.parse(reader.result as string);
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          reject(new Error('Invalid list definition file'));
          return;
        }
        // Imports get fresh timestamps and identity, after the saved shape is checked.
        const migrated = decodeSavedList(raw);
        resolve({ ...migrated, id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now() });
      } catch {
        reject(new Error('Failed to parse list definition file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
