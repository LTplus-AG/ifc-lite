/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Full-model incoming-reference guard for destructive cost authoring. */

import { effectiveCreatedRecord, effectiveSourceRecord } from '@ifc-lite/export';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

function referencedTargetCounts(text: string, targetIds: ReadonlySet<number>): Map<number, number> {
  const found = new Map<number, number>();
  let inString = false;
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    if (inComment) {
      if (text[i] === '*' && text[i + 1] === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (!inString && text[i] === '/' && text[i + 1] === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (text[i] === "'") {
      if (inString && text[i + 1] === "'") {
        i++;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (inString || text[i] !== '#') continue;
    let value = 0;
    let cursor = i + 1;
    if (cursor >= text.length || text[cursor] < '0' || text[cursor] > '9') continue;
    while (cursor < text.length && text[cursor] >= '0' && text[cursor] <= '9') {
      value = value * 10 + Number(text[cursor]);
      cursor++;
    }
    if (targetIds.has(value)) found.set(value, (found.get(value) ?? 0) + 1);
    i = cursor - 1;
  }
  return found;
}

/**
 * Index effective records that point at any target id. One pass covers the
 * entity being removed and every candidate cascade value, so deletion cost is
 * linear in model size rather than one full-model scan per cost value.
 * Non-relationship SELECT references such as
 * `IfcMetric.DataValue -> IfcCostValue` therefore cannot be orphaned.
 */
export function effectiveCostReferenceOccurrences(
  store: IfcDataStore,
  view: MutablePropertyView,
  targetIds: ReadonlySet<number>,
): Map<number, Map<number, number>> {
  const referrers = new Map<number, Map<number, number>>();
  const seen = new Set<number>();
  const visitSource = (id: number, ref: { byteOffset: number; byteLength: number; type: string }) => {
    if (seen.has(id) || view.isDeleted(id)) return;
    seen.add(id);
    const sourceText = store.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
    const record = effectiveSourceRecord(view, id, sourceText, ref.type, store.schemaVersion);
    for (const [targetId, count] of referencedTargetCounts(record.text, targetIds)) {
      if (targetId === id) continue;
      const incoming = referrers.get(targetId) ?? new Map<number, number>();
      incoming.set(id, count);
      referrers.set(targetId, incoming);
    }
  };
  for (const [id, ref] of store.entityIndex.byId) visitSource(id, ref);
  for (const [id, ref] of store.deferredEntityIndex ?? []) visitSource(id, ref);
  for (const entity of view.getNewEntities()) {
    if (seen.has(entity.expressId)) continue;
    const record = effectiveCreatedRecord(view, entity.expressId, store.schemaVersion);
    if (!record) continue;
    for (const [targetId, count] of referencedTargetCounts(record.text, targetIds)) {
      if (targetId === entity.expressId) continue;
      const incoming = referrers.get(targetId) ?? new Map<number, number>();
      incoming.set(entity.expressId, count);
      referrers.set(targetId, incoming);
    }
  }
  return referrers;
}

export function effectiveCostReferrers(
  store: IfcDataStore,
  view: MutablePropertyView,
  targetIds: ReadonlySet<number>,
): Map<number, number[]> {
  return new Map(
    [...effectiveCostReferenceOccurrences(store, view, targetIds)]
      .map(([targetId, occurrences]) => [targetId, [...occurrences.keys()]]),
  );
}
