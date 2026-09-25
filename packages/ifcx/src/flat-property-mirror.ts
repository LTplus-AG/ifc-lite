/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isTypedPropertyValue, parseV5aKey } from './types.js';

const FLAT_PROP_PREFIX = 'bsi::ifc::prop::';

/**
 * Flat `bsi::ifc::prop::<Name>` keys that only MIRROR a pset-qualified
 * `bsi::ifc::v5a::<Set>::<Name>` value on the same node (#5376). The IFCX
 * exporter writes the flat key for names the official IFC5 property schema
 * defines, so standard consumers find them, and the qualified key so the pset
 * survives. Reading both would list the property twice (once in the catch-all
 * set or the quantity table), so the mirror is skipped. A flat key whose value
 * matches no qualified member is kept: it is its own fact, not a mirror.
 */
export function mirroredFlatPropertyKeys(attributes: Map<string, unknown>): Set<string> {
  const qualified = new Map<string, Set<string>>();
  for (const [key, value] of attributes) {
    const v5a = parseV5aKey(key);
    if (!v5a) continue;
    const effective = isTypedPropertyValue(value) ? value.value : value;
    const values = qualified.get(v5a.name) ?? new Set<string>();
    values.add(JSON.stringify(effective));
    qualified.set(v5a.name, values);
  }
  const mirrored = new Set<string>();
  if (qualified.size === 0) return mirrored;
  for (const [key, value] of attributes) {
    if (!key.startsWith(FLAT_PROP_PREFIX)) continue;
    if (qualified.get(key.slice(FLAT_PROP_PREFIX.length))?.has(JSON.stringify(value))) mirrored.add(key);
  }
  return mirrored;
}
