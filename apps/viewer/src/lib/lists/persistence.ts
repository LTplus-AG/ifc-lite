/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistence for list definitions via localStorage
 */

import { trackExportCompleted } from '@/lib/analytics';
import { type ListDefinition } from '@ifc-lite/lists';
import { downloadFile, sanitizeFilename } from '../export/download.js';

import { readLocalLibrary, saveLocalLibrary } from '../storage/local-library-source.js';
import type { SaveResult } from '../storage/save-result.js';
import { decodeSavedList, encodeSavedList } from './saved-list-codec.js';

const STORAGE_KEY = 'ifc-lite-lists';

export function readListLibrarySource() {
  return readLocalLibrary(STORAGE_KEY, value => decodeSavedList(value));
}

export function loadListDefinitions(): ListDefinition[] {
  return readListLibrarySource().rows;
}

export function saveListDefinitionsResult(definitions: ListDefinition[]): SaveResult {
  const source = readListLibrarySource();
  try {
    return saveLocalLibrary(STORAGE_KEY, definitions.map(encodeSavedList), source, 'Lists');
  } catch (error) {
    console.warn('[Lists] Failed to serialize list definitions', error);
    return { ok: false, reason: 'serialize', message: 'Could not save List changes.' };
  }
}

export function saveListDefinitions(definitions: ListDefinition[]): boolean {
  return saveListDefinitionsResult(definitions).ok;
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
        const migrated = decodeSavedList(raw, Date.now());
        resolve({ ...migrated, id: crypto.randomUUID() });
      } catch {
        reject(new Error('Failed to parse list definition file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
