/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SchemaRegistry } from './generated/schema-registry-by-version.js';

const indexes = new WeakMap<SchemaRegistry['entities'], { signature: string; names: Map<string, string> }>();

/** Resolve the first own registry key matching the IFC name, case-insensitively.
 * Public registries remain mutable: additions, deletions and key order invalidate
 * the index; replacing a definition never caches its old metadata.
 */
export function getCanonicalEntityName(registry: SchemaRegistry, type: string): string | undefined {
  const entities = registry.entities;
  const keys = Object.keys(entities);
  const signature = JSON.stringify(keys);
  let index = indexes.get(entities);
  if (!index || index.signature !== signature) {
    const names = new Map<string, string>();
    for (const key of keys) {
      const upper = key.toUpperCase();
      if (!names.has(upper)) names.set(upper, key);
    }
    index = { signature, names };
    indexes.set(entities, index);
  }
  return index.names.get(type.toUpperCase());
}
