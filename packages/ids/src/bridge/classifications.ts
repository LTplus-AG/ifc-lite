/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  type IfcDataStore,
  EntityExtractor,
  extractClassificationsOnDemand,
} from '@ifc-lite/parser';
import type { ClassificationInfo } from '../types.js';

interface ClassRecord {
  system?: string;
  identification?: string;
  name?: string;
  path?: string[];
}

/**
 * Resolve every classification associated with `expressId`, including
 *   1. the standard `IfcRelAssociatesClassification` path (handled by
 *      the parser's resolver), and
 *   2. the non-rooted-resource path: `IfcExternalReferenceRelationship`
 *      pointing at the entity from `RelatedResourceObjects`.
 *
 * Each classification is expanded into multiple `ClassificationInfo`
 * entries — one per parent reference in the chain — so a requirement
 * for `EF_25_10` matches an actual leaf of `EF_25_10_25`.
 */
export function resolveClassifications(
  store: IfcDataStore,
  expressId: number
): ClassificationInfo[] {
  const list: ClassRecord[] = [
    ...(extractClassificationsOnDemand(store, expressId) || []),
  ];

  appendExternalReferenceClassifications(store, expressId, list);

  const out: ClassificationInfo[] = [];
  for (const c of list) {
    const system = c.system || '';
    const baseValue = c.identification || c.name || '';
    // Always push at least one entry per associated classification —
    // even when the value is empty — so optional-cardinality value
    // mismatches register as a value mismatch rather than as a
    // missing-classification (which optional pardons).
    out.push({ system, value: baseValue, name: c.name });
    if (Array.isArray(c.path)) {
      for (const code of c.path) {
        if (code && code !== baseValue) {
          out.push({ system, value: code, name: c.name });
        }
      }
    }
  }
  return out;
}

/**
 * Non-rooted resources (IfcMaterial, IfcProfileDef, …) carry
 * classifications via `IfcExternalReferenceRelationship` rather than
 * `IfcRelAssociatesClassification`. The parser doesn't categorize
 * external-ref edges into the relationship graph today, so we scan
 * the type table directly.
 */
function appendExternalReferenceClassifications(
  store: IfcDataStore,
  expressId: number,
  list: ClassRecord[]
): void {
  const erRefs =
    store.entityIndex?.byType?.get?.('IFCEXTERNALREFERENCERELATIONSHIP') || [];
  if (erRefs.length === 0 || !store.source?.length) return;
  const ex = new EntityExtractor(store.source);

  for (const erId of erRefs) {
    const erRef = store.entityIndex.byId.get(erId);
    if (!erRef) continue;
    const erEntity = ex.extractEntity(erRef);
    if (!erEntity) continue;
    // [Name, Description, RelatingReference, RelatedResourceObjects]
    const relating = erEntity.attributes?.[2];
    const related = erEntity.attributes?.[3];
    if (typeof relating !== 'number') continue;
    if (!Array.isArray(related)) continue;
    if (!related.includes(expressId)) continue;

    const refRef = store.entityIndex.byId.get(relating);
    if (!refRef) continue;
    const refEntity = ex.extractEntity(refRef);
    if (!refEntity) continue;
    if (refEntity.type.toUpperCase() !== 'IFCCLASSIFICATIONREFERENCE') continue;

    const a = refEntity.attributes || [];
    const info: ClassRecord = {
      identification: typeof a[1] === 'string' ? a[1] : undefined,
      name: typeof a[2] === 'string' ? a[2] : undefined,
      path: [],
    };

    let cursor = typeof a[3] === 'number' ? a[3] : undefined;
    const seen = new Set<number>();
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      const cur = store.entityIndex.byId.get(cursor);
      if (!cur) break;
      const e = ex.extractEntity(cur);
      if (!e) break;
      const cu = e.type.toUpperCase();
      const ca = e.attributes || [];
      if (cu === 'IFCCLASSIFICATION') {
        info.system = typeof ca[3] === 'string' ? ca[3] : undefined;
        break;
      }
      if (cu === 'IFCCLASSIFICATIONREFERENCE') {
        const code =
          typeof ca[1] === 'string'
            ? ca[1]
            : typeof ca[2] === 'string'
              ? ca[2]
              : undefined;
        if (code) info.path!.unshift(code);
        cursor = typeof ca[3] === 'number' ? ca[3] : undefined;
        continue;
      }
      break;
    }
    list.push(info);
  }
}
