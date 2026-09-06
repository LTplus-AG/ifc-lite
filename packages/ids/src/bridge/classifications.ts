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
  unresolved?: boolean;
  presenceUnknown?: boolean;
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
    out.push({
      system,
      value: baseValue,
      name: c.name,
      unresolved: c.unresolved,
      presenceUnknown: c.presenceUnknown,
    });
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
 *
 * On a server-parsed (source-empty) store this type table is not merely
 * incomplete — it structurally cannot contain `IFCEXTERNALREFERENCERELATIONSHIP`
 * (or `IFCMATERIAL`/`IFCPROFILEDEF`) entries at all: the server pipeline's
 * `IfcTypeEnum` (packages/data/src/types.ts) has no slot for any of them, and
 * the server resolves classifications only via `IfcRelAssociatesClassification`
 * (apps/server/src/services/data_model/classifications.rs). So an empty
 * `byType` lookup here proves nothing about whether THIS entity carries a
 * classification through this pathway — unlike the sibling
 * `IfcRelAssociatesClassification` path (#3951), there is no
 * relationship-graph fallback at all for this one (#3954): presence cannot
 * be proven OR disproven without source bytes.
 */
function appendExternalReferenceClassifications(
  store: IfcDataStore,
  expressId: number,
  list: ClassRecord[]
): void {
  if (!store.source?.length) {
    // Only fall back to "cannot determine" when:
    //  1. the IfcRelAssociatesClassification path (already applied to `list`
    //     by the caller) found nothing — an entity already confirmed
    //     classified, or confirmed-but-unresolved, through that path doesn't
    //     also rely on this non-rooted-resource pathway, so leave it
    //     untouched rather than diluting a real match/mismatch into
    //     "unresolved"; and
    //  2. `expressId` could actually BE a `RelatedResourceObjects` target —
    //     the IFC schema restricts that role to non-rooted resource-level
    //     entities (IfcResourceObjectSelect: IfcMaterial(Select) members,
    //     IfcProfileDef, …), never an IfcRoot subtype like IfcWall. A rooted
    //     element's `list.length === 0` genuinely means unclassified — no
    //     external-ref ambiguity is even schema-possible for it — so
    //     blanket-marking every empty result as unresolved would regress the
    //     overwhelming common case (a genuinely unclassified wall/door/etc.)
    //     into a false "cannot determine" on every server-parsed model.
    if (list.length === 0 && isNonRootedClassifiableResource(store, expressId)) {
      list.push({ unresolved: true, presenceUnknown: true });
    }
    return;
  }

  const erRefs =
    store.entityIndex?.byType?.get?.('IFCEXTERNALREFERENCERELATIONSHIP') || [];
  if (erRefs.length === 0) return;
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

/**
 * Could `expressId` be a `RelatedResourceObjects` target of an
 * `IfcExternalReferenceRelationship`? The IFC schema restricts that role to
 * `IfcResourceObjectSelect` members — `IfcMaterial` (and its sibling
 * material-select types) and `IfcProfileDef` are the ones this bridge's
 * on-the-wire comment names — never an `IfcRoot` subtype (`IfcWall`,
 * `IfcDoor`, …), which can only be classified via
 * `IfcRelAssociatesClassification`. `EntityRef.type` is available from the
 * type-table index without reading `source` bytes (it's set from the raw
 * STEP/server type name, not extracted attributes), so this check costs
 * nothing on a server-parsed store.
 */
function isNonRootedClassifiableResource(
  store: IfcDataStore,
  expressId: number
): boolean {
  const type = store.entityIndex?.byId?.get?.(expressId)?.type;
  if (typeof type !== 'string') return false;
  const upper = type.toUpperCase();
  return (
    upper === 'IFCMATERIAL' ||
    upper.startsWith('IFCMATERIAL') || // IfcMaterialLayer(Set), IfcMaterialProfile(Set), IfcMaterialConstituent(Set), IfcMaterialList
    upper.endsWith('PROFILEDEF') // IfcProfileDef and every concrete subtype (e.g. IfcRectangleProfileDef)
  );
}
