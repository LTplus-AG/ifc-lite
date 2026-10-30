/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { diffKeyAliasesFromLineage, diffLineageConflicts, diffRekeyByLineage } from '@ifc-lite/wasm/diff';
import { diffModelConstructor } from './wasm-runtime.js';
import type { Lineage, LineageEntry, RekeyPolicy, RekeyResult } from './lineage.js';

// The host ABI takes live JS values; older generated declarations narrow the
// iterable arguments to arrays. Keep iteration inside Rust's observation order.
const rekey = diffRekeyByLineage as (keys: Iterable<string>, entries: readonly LineageEntry[], deleted: Iterable<string>, policy: RekeyPolicy) => RekeyResult[];

/** Preserve the public array result while Rust owns conflict detection. */
export function lineageConflicts(entries: readonly LineageEntry[]): string[] {
  diffModelConstructor();
  return diffLineageConflicts(entries);
}

/** Rust returns ordered pairs; JavaScript restores the public Map container. */
export function keyAliasesFromLineage(entries: readonly LineageEntry[]): Map<string, string> {
  diffModelConstructor();
  return new Map(diffKeyAliasesFromLineage(entries) as [string, string][]);
}

/** Rust observes iterables live, after indexing lineage and deleted keys. */
export function rekeyByLineage(keys: Iterable<string>, lineage: Lineage | readonly LineageEntry[], policy: RekeyPolicy = 'copy-to-all'): RekeyResult[] {
  diffModelConstructor();
  const entries = Array.isArray(lineage) ? lineage as readonly LineageEntry[] : (lineage as Lineage).entries;
  const deleted = Array.isArray(lineage) ? [] : (lineage as Lineage).deleted ?? [];
  return rekey(keys, entries, deleted, policy);
}
