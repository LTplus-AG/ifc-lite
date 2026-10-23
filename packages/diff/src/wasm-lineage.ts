/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { diffKeyAliasesFromLineage, diffLineageConflicts, diffRekeyByLineage } from '@ifc-lite/wasm';
import { diffModelConstructor } from './wasm-runtime.js';
import type { Lineage, LineageEntry, RekeyPolicy, RekeyResult } from './lineage.js';

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

/** Materialize iterable keys once, retaining synchronous calls after init. */
export function rekeyByLineage(keys: Iterable<string>, lineage: Lineage | readonly LineageEntry[], policy: RekeyPolicy = 'copy-to-all'): RekeyResult[] {
  diffModelConstructor();
  const entries = Array.isArray(lineage) ? lineage as readonly LineageEntry[] : (lineage as Lineage).entries;
  const deleted = Array.isArray(lineage) ? [] : (lineage as Lineage).deleted ?? [];
  return diffRekeyByLineage([...keys], entries, [...deleted], policy) as RekeyResult[];
}
