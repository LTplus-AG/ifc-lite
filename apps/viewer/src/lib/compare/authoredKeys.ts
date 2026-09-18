/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authored keys for the viewer's compare adapter (issue #4955): key the
 * comparison on `Tag` or a `Pset.Prop` the model maintains on purpose,
 * instead of GlobalId. Split out of `buildFingerprints.ts` for size.
 */

import { EntityExtractor, authoredKeyValue, parseAuthoredKeySpec, type IfcDataStore } from '@ifc-lite/parser';

/** Prefix on a fingerprint key taken from an authored property rather than a GlobalId. */
export const AUTHORED_KEY_PREFIX = 'prop:';

/**
 * local express id -> `prop:<value>` for every entity carrying a non-empty
 * value nobody else does. Resolved in one pass so a value two entities share
 * is refused for both (reported on `duplicateAuthoredKeys`) rather than the
 * diff's first-wins index quietly keeping one. Empty when no spec is given.
 */
export function resolveAuthoredKeys(
  store: IfcDataStore,
  localIds: Iterable<number>,
  keyProperty: string | undefined,
  duplicateAuthoredKeys?: Map<string, number[]>,
): Map<number, string> {
  const keys = new Map<number, string>();
  const spec = keyProperty ? parseAuthoredKeySpec(keyProperty) : undefined;
  if (!spec) return keys;
  const extractor = new EntityExtractor(store.source);
  const owners = new Map<string, number[]>();
  for (const localId of localIds) {
    const value = authoredKeyValue(store, localId, spec, extractor);
    if (value === undefined) continue;
    const list = owners.get(value);
    if (list) list.push(localId);
    else owners.set(value, [localId]);
  }
  for (const [value, ids] of owners) {
    if (ids.length === 1) keys.set(ids[0], `${AUTHORED_KEY_PREFIX}${value}`);
    else duplicateAuthoredKeys?.set(value, ids);
  }
  return keys;
}
