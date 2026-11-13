/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SchemaRegistry } from './generated/schema-registry-by-version.js';

const indexes = new WeakMap<SchemaRegistry['entities'], { keys: readonly string[]; names: Map<string, string> }>();

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
  const names = entityNameIndex(registry.entities);
  return { registry, resolve: type => names.get(type.toUpperCase()) };
}

/** The same key list in the same order. A serialised signature answered this
 * too, at one `JSON.stringify` of every entity name per lookup: about 18
 * microseconds, paid per record by any reader without a snapshot (#9906). */
function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function entityNameIndex(entities: SchemaRegistry['entities']): Map<string, string> {
  const keys = Object.keys(entities);
  let index = indexes.get(entities);
  if (!index || !sameKeys(index.keys, keys)) {
    index = { keys, names: indexNames(keys) };
    indexes.set(entities, index);
  }
  return index.names;
}

/** Resolve the first own registry key matching the IFC name, case-insensitively.
 * Without a snapshot, additions, deletions and key order invalidate
 * the index; replacing a definition never caches its old metadata.
 */
export function getCanonicalEntityName(registry: SchemaRegistry, type: string, snapshot?: SchemaEntityNameSnapshot): string | undefined {
  if (snapshot?.registry === registry) return snapshot.resolve(type);
  return entityNameIndex(registry.entities).get(type.toUpperCase());
}
