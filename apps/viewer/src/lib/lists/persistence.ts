/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistence for list definitions via localStorage
 */

import type { ListDefinition } from '@ifc-lite/lists';
import { downloadFile, sanitizeFilename } from '../export/download.js';

const STORAGE_KEY = 'ifc-lite-lists';

export function loadListDefinitions(): ListDefinition[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ListDefinition[];
  } catch {
    return [];
  }
}

export function saveListDefinitions(definitions: ListDefinition[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(definitions));
  } catch {
    console.warn('[Lists] Failed to save list definitions to localStorage');
  }
}

export function exportListDefinition(definition: ListDefinition): void {
  const json = JSON.stringify(definition, null, 2);
  const name = sanitizeFilename(definition.name, { fallback: 'list' });
  downloadFile(json, `${name}.list.json`, 'application/json');
}

export function importListDefinition(file: File): Promise<ListDefinition> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const def = JSON.parse(reader.result as string) as ListDefinition;
        if (!def.id || !def.name || !def.entityTypes || !def.columns) {
          reject(new Error('Invalid list definition file'));
          return;
        }
        // Generate a new ID to avoid collisions
        def.id = crypto.randomUUID();
        def.createdAt = Date.now();
        def.updatedAt = Date.now();
        resolve(def);
      } catch {
        reject(new Error('Failed to parse list definition file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
