/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `Tag` half of the compare data fingerprint (issue #2021).
 *
 * Two questions, both of which must be answered across the **union of the
 * bundled schemas** (IFC2X3 + IFC4 + IFC4X3) rather than through the parser's
 * IFC4 codegen pin: *is this class a type object*, and *where does its `Tag`
 * sit*. They live together here because getting one from the union and the
 * other from the pin is a silent no-op rather than an error — see
 * {@link typeObjectTag}.
 *
 * Split out of `buildFingerprints.ts` to keep that module under the ~400-line
 * guideline, and because this pair is a self-contained schema question with its
 * own tests.
 */

import {
  EntityExtractor,
  getAttributeNamesAcrossSchemas,
  getInheritanceChainAcrossSchemas,
  type IfcDataStore,
} from '@ifc-lite/parser';

/** class name → is it an `IfcTypeObject`. A property of the class, asked once
 *  per fingerprinted entity, so it is worth remembering. */
const typeObjectByClass = new Map<string, boolean>();

/**
 * Is this IFC class an `IfcTypeObject` subtype?
 *
 * Answered from the cross-schema inheritance chain, never from the name: IFC2X3's
 * `IfcDoorStyle` and `IfcWindowStyle` are type objects whose names do not end in
 * `Type`, and the Duplex sample is full of both.
 */
export function isTypeObjectClass(ifcType: string): boolean {
  const cached = typeObjectByClass.get(ifcType);
  if (cached !== undefined) return cached;
  const isTypeObject = getInheritanceChainAcrossSchemas(ifcType.toUpperCase()).includes(
    'IfcTypeObject',
  );
  typeObjectByClass.set(ifcType, isTypeObject);
  return isTypeObject;
}

/**
 * A type object's `Tag`, read positionally through the **cross-schema**
 * attribute list.
 *
 * `extractAllEntityAttributes` names attributes through the parser's IFC4
 * codegen pin, which answers an EMPTY list for a class the pin does not carry —
 * so a `.find(name === 'Tag')` over it silently finds nothing on every
 * IFC4X3-only type object (`IfcRailType`, `IfcTrackElementType`,
 * `IfcSignalType`, …) while working perfectly on IFC2X3 and IFC4. Nothing about
 * that failure is visible: the entity is fingerprinted, its class name is right,
 * {@link isTypeObjectClass} is right, and only the evidence is missing.
 *
 * The two lookups therefore have to come from the same place. The chain decides
 * *whether* to read a `Tag`; the attribute list decides *where* it sits, so it
 * must span the same schemas or the pair disagrees about which classes exist.
 * `getAttributeNamesAcrossSchemas` returns the pinned result unchanged for every
 * class the pin does know, so this is additive: no IFC2X3 or IFC4 entity's hash
 * moves because of it.
 *
 * Reads the raw STEP slot rather than the display-normalized value: this is
 * hashed, not shown, and `$` (absent) is the only case needing interpretation —
 * it arrives as null and yields `undefined`.
 */
export function typeObjectTag(
  store: IfcDataStore,
  expressId: number,
  ifcType: string,
): string | undefined {
  const index = getAttributeNamesAcrossSchemas(ifcType).indexOf('Tag');
  if (index < 0) return undefined;
  const ref = store.entityIndex.byId.get(expressId);
  if (!ref) return undefined;
  const raw = new EntityExtractor(store.source).extractEntity(ref)?.attributes?.[index];
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
}
