/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SchemaRegistry } from './generated/schema-registry-by-version.js';

const indexes = new WeakMap<SchemaRegistry['entities'], { signature: string; names: Map<string, string> }>();

/** Ordered entity keys captured for one finite operation; definitions remain live. */
export interface SchemaEntityNameSnapshot {
  readonly registry: SchemaRegistry;
  resolve(type: string): string | undefined;
}

function indexNames(keys: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const key of keys) {
    const upper = key.toUpperCase();
    if (!names.has(upper)) names.set(upper, key);
  }
  return names;
}

/** Capture key order once. Create a fresh snapshot after registry key changes. */
export function createSchemaEntityNameSnapshot(registry: SchemaRegistry): SchemaEntityNameSnapshot {
  const names = indexNames(Object.keys(registry.entities));
  return { registry, resolve: type => names.get(type.toUpperCase()) };
}

/** Resolve the first own registry key matching the IFC name, case-insensitively.
 * Public registries remain mutable: additions, deletions and key order invalidate
 * the index; replacing a definition never caches its old metadata.
 */
export function getCanonicalEntityName(registry: SchemaRegistry, type: string, snapshot?: SchemaEntityNameSnapshot): string | undefined {
  if (snapshot?.registry === registry) return snapshot.resolve(type);
  const entities = registry.entities;
  const keys = Object.keys(entities);
  const signature = JSON.stringify(keys);
  let index = indexes.get(entities);
  if (!index || index.signature !== signature) {
    const names = indexNames(keys);
    index = { signature, names };
    indexes.set(entities, index);
  }
  return index.names.get(type.toUpperCase());
}
