/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Row identity for table corrections (P15): each table row names exactly one
 * element of one model through its identity column. GlobalId uses the native
 * GlobalId index; Tag and Name are matched exactly against the effective
 * (edited) value of every element in the session. A key that is empty, appears
 * on several rows, matches nothing or matches several elements is reported and
 * its row skipped: a key is never guessed.
 */

import { iterateEffectiveEntityIds, type CsvRow } from '@ifc-lite/mutations';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import type { ConversionIssue } from './change-conversion';
import { effectiveAttribute, type ModelReader } from './model-change-values';
import type { IdentityKey } from './table-mapping';

/** Tag is not indexed by the parser, so a Tag-keyed table reads each element's Tag; bounded. */
export const TAG_SCAN_LIMIT = 200_000;

export type IdentityOutcome =
  | { ok: true; entities: Map<number, number>; issues: ConversionIssue[] }
  | { ok: false; reason: 'tag-scan-limit' };

const elementTypes = new Map<string, boolean>();
function isElement(type: string): boolean {
  let known = elementTypes.get(type);
  if (known === undefined) {
    known = getInheritanceChainAcrossSchemas(type).includes('IfcElement');
    elementTypes.set(type, known);
  }
  return known;
}

/** Exact effective value → element ids, for the keys the table actually uses. */
function attributeIndex(reader: ModelReader, key: 'Tag' | 'Name', wanted: ReadonlySet<string>): Map<string, number[]> | null {
  const { dataStore, view } = reader;
  const index = new Map<string, number[]>();
  let scanned = 0;
  for (const { expressId, type } of iterateEffectiveEntityIds(dataStore, view, undefined, dataStore.entities.expressId)) {
    // Tag is an IfcElement attribute; Name is read from the parsed columns for every entity.
    if (key === 'Tag') {
      if (!isElement(type)) continue;
      if (++scanned > TAG_SCAN_LIMIT) return null;
    }
    const value = effectiveAttribute(reader, expressId, key);
    if (!value || !wanted.has(value)) continue;
    const hits = index.get(value);
    if (hits) hits.push(expressId); else index.set(value, [expressId]);
  }
  return index;
}

export function resolveTableIdentity(reader: ModelReader, rows: readonly CsvRow[],
  identity: { column: string; key: IdentityKey }): IdentityOutcome {
  const issues: ConversionIssue[] = [];
  const keys = rows.map((row) => (row[identity.column] ?? '').trim());
  const counts = new Map<string, number>();
  for (const key of keys) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  const wanted = new Set([...counts].filter(([, count]) => count === 1).map(([key]) => key));

  let lookup: (key: string) => number[];
  if (identity.key === 'GlobalId') {
    const { entities } = reader.dataStore;
    lookup = (key) => {
      const id = entities.getExpressIdByGlobalId(key);
      return id !== undefined && id > 0 && !reader.view.isDeleted(id) ? [id] : [];
    };
  } else {
    const index = attributeIndex(reader, identity.key, wanted);
    if (!index) return { ok: false, reason: 'tag-scan-limit' };
    lookup = (key) => index.get(key) ?? [];
  }

  const entities = new Map<number, number>();
  keys.forEach((key, rowIndex) => {
    const row = rowIndex + 1;
    if (!key) { issues.push({ kind: 'missing-key', row, column: identity.column }); return; }
    if ((counts.get(key) ?? 0) > 1) { issues.push({ kind: 'duplicate-key', row, column: identity.column, element: key }); return; }
    const hits = lookup(key);
    if (hits.length === 0) issues.push({ kind: 'unmatched-key', row, column: identity.column, element: key });
    else if (hits.length > 1) issues.push({ kind: 'ambiguous-key', row, column: identity.column, element: key, detail: String(hits.length) });
    else entities.set(rowIndex, hits[0]);
  });
  return { ok: true, entities, issues };
}
