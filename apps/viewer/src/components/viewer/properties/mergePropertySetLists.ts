/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PropertySet } from './encodingUtils';

type DisplayProperty = { name: string; value: unknown; isMutated: boolean; type?: number; dataType?: string };
export type DisplayPropertySet = {
  name: string;
  properties: DisplayProperty[];
  isNewPset: boolean;
  source?: PropertySet['source'];
};

export function mergePropertySetLists(base: DisplayPropertySet[], incoming: DisplayPropertySet[]): DisplayPropertySet[] {
  const merged = base.map(pset => ({ ...pset, properties: [...pset.properties] }));
  const psetMap = new Map(merged.map(pset => [pset.name, pset]));

  for (const incomingPset of incoming) {
    const existing = psetMap.get(incomingPset.name);
    if (!existing) {
      const copy = { ...incomingPset, properties: [...incomingPset.properties] };
      merged.push(copy);
      psetMap.set(copy.name, copy);
      continue;
    }

    const existingPropMap = new Set(existing.properties.map(prop => prop.name));
    for (const prop of incomingPset.properties) {
      if (!existingPropMap.has(prop.name)) {
        existing.properties.push(prop);
      }
    }
  }

  return merged;
}
