/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Attribute reading for the MCP diff adapter, and authored keys (issue #4955): `key_from` keys the
 * comparison on `Tag` or a `Pset.Prop` instead of GlobalId. Read through the
 * session OVERLAY, like every other fingerprinted value, so a queued edit or
 * tombstone is what the comparison sees. Split out of `diff-fingerprints.ts`
 * for size.
 */

import {
  EntityExtractor,
  authoredKeyValue,
  getAttributeNamesAcrossSchemas,
  parseAuthoredKeySpec,
  type IfcDataStore,
} from '@ifc-lite/parser';
import type { PendingOverlay } from '../overlay.js';

/** Adapter options (issue #4955); the CLI's `FingerprintAdapterOptions` restated. */
export interface FingerprintAdapterOptions {
  /** `Tag` or `<PsetName>.<PropertyName>`; see the CLI copy for the rules. */
  keyProperty?: string;
  duplicateAuthoredKeys?: Map<string, number[]>;
}

/** Prefix on a fingerprint key taken from an authored property rather than a GlobalId. */
export const AUTHORED_KEY_PREFIX = 'prop:';

/**
 * Build the key resolver for one model: `prop:<value>` where the entity carries
 * a non-empty value nobody else does, GlobalId otherwise. Duplicate values are
 * reported on `options.duplicateAuthoredKeys`. Tombstoned entities are not
 * owners: a deleted twin no longer contests the key. A created entity has no
 * store row to read and keeps its GlobalId.
 */
export function authoredKeyResolver(
  store: IfcDataStore,
  overlay: PendingOverlay | null | undefined,
  options: FingerprintAdapterOptions,
  extractor: EntityExtractor,
  isDependentType: (typeKey: string) => boolean,
): (expressId: number, globalId: string) => string {
  const keySpec = options.keyProperty ? parseAuthoredKeySpec(options.keyProperty) : undefined;
  if (!keySpec) return (_expressId, globalId) => globalId;

  const authoredKeyOf = (expressId: number): string | undefined => {
    if (keySpec.kind === 'tag') {
      const edited = overlay?.attributes(expressId).get('Tag');
      if (edited !== undefined) return edited.trim().length > 0 ? edited.trim() : undefined;
    } else if (overlay) {
      const set = overlay.propertySets(expressId).find((pset) => pset.name === keySpec.pset);
      const property = set?.properties.find((p) => p.name === keySpec.property);
      if (set) {
        const raw = property?.value;
        if (raw === null || raw === undefined) return undefined;
        const value = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        return value.trim().length > 0 ? value.trim() : undefined;
      }
    }
    return authoredKeyValue(store, expressId, keySpec, extractor);
  };

  // A first pass so a value two entities share can be refused for both,
  // instead of the diff's first-wins index quietly keeping one.
  const owners = new Map<string, number[]>();
  for (const [typeKey, ids] of store.entityIndex.byType) {
    if (isDependentType(typeKey)) continue;
    for (const expressId of ids) {
      if (overlay?.deleted.has(expressId)) continue;
      const value = authoredKeyOf(expressId);
      if (value === undefined) continue;
      const list = owners.get(value);
      if (list) list.push(expressId);
      else owners.set(value, [expressId]);
    }
  }
  for (const [value, ids] of owners) {
    if (ids.length > 1) options.duplicateAuthoredKeys?.set(value, ids);
  }
  return (expressId, globalId) => {
    const value = authoredKeyOf(expressId);
    if (value === undefined) return globalId;
    return (owners.get(value)?.length ?? 0) === 1 ? `${AUTHORED_KEY_PREFIX}${value}` : globalId;
  };
}

/**
 * One named attribute, read positionally through the **cross-schema** attribute
 * list (issue #2021). The CLI's twin, and it must stay one.
 *
 * `extractAllEntityAttributes` names attributes through the parser's IFC4
 * codegen pin, which answers an EMPTY list for a class the pin does not carry —
 * so a `.find(name === 'Tag')` over it silently finds nothing on every
 * IFC4X3-only type object (`IfcRailType`, `IfcTrackElementType`,
 * `IfcSignalType`, …) while working perfectly on IFC2X3 and IFC4. That is a
 * no-op nobody would notice: the entity is in scope, its class name is right,
 * `isTypeObject` is right, and only the evidence is missing.
 *
 * This is the same pinned-registry family as the membership defect `#2001`
 * fixed, and it has to be answered from the same place: the inheritance chain
 * decides *whether* to read a `Tag`, so the attribute list that decides *where*
 * it sits must span the same schemas. `getAttributeNamesAcrossSchemas` returns
 * the pinned result unchanged for every class the pin does know, so this is
 * additive — no IFC2X3 or IFC4 entity's hash moves because of it.
 *
 * Reads the raw STEP slot rather than reusing `extractAllEntityAttributes`'
 * display normalization: this value is hashed, not shown, so `$` (absent) is
 * the only case that needs interpreting and it arrives as null.
 */
export function attributeAcrossSchemas(
  store: IfcDataStore,
  expressId: number,
  ifcType: string,
  attributeName: string,
): string | undefined {
  const index = getAttributeNamesAcrossSchemas(ifcType).indexOf(attributeName);
  if (index < 0) return undefined;
  const ref = store.entityIndex.byId.get(expressId);
  if (!ref) return undefined;
  const raw = new EntityExtractor(store.source).extractEntity(ref)?.attributes?.[index];
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
}

/**
 * An overlay override wins whenever one exists, including when it is empty —
 * `entity_set_attribute` with `''` clears the attribute, and falling back to
 * the stored value there would hash the edit away.
 */
export function override(edited: string | undefined, stored: string | undefined): string | undefined {
  const value = edited !== undefined ? edited : stored;
  return value ? value : undefined;
}
