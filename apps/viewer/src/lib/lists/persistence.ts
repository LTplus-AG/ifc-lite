/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistence for list definitions via localStorage
 */

import { trackExportCompleted } from '@/lib/analytics';
import { migrateLegacyListConditions, type ListDefinition } from '@ifc-lite/lists';
import { downloadFile, sanitizeFilename } from '../export/download.js';

const STORAGE_KEY = 'ifc-lite-lists';

/** Save the canonical group form alongside v1 conditions during the staged
 * migration. The old evaluator still reads conditions until #5894's runtime
 * stack lands; unreadable rows remain explicit instead of disappearing. */
function withMigratedGroups(definition: ListDefinition): ListDefinition {
  if (typeof definition !== 'object' || definition === null) return definition;
  if (definition.groups !== undefined || !Array.isArray(definition.conditions)) return definition;
  // A damaged v1 entry must not throw during the array-wide localStorage
  // load and hide otherwise valid lists. Preserve it untouched for recovery.
  if (!definition.conditions.every((condition) => typeof condition === 'object' && condition !== null)) return definition;
  const { groups, unreadableConditions } = migrateLegacyListConditions(definition.conditions);
  return { ...definition, groups, ...(unreadableConditions.length ? { unreadableConditions } : {}) };
}

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
    return Array.isArray(parsed) ? (parsed as ListDefinition[]).map(withMigratedGroups) : [];
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
  trackExportCompleted({ format: 'json', surface: 'list_results' });
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
        resolve(withMigratedGroups(def));
      } catch {
        reject(new Error('Failed to parse list definition file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
