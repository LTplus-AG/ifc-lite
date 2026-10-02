/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isTypedPropertyValue, parseV5aKey, type IfcxFile } from '@ifc-lite/ifcx';
import { validatePropertyDataType } from '@ifc-lite/export';

/** Quarantine rejected declarations in the derived snapshot; preserve the peer's original CRDT record. */
export function validatedRoomPropertySnapshot(snapshot: IfcxFile, onReject: (message: string) => void): IfcxFile {
  return { ...snapshot, data: snapshot.data.map(node => {
    if (!node.attributes) return node;
    const attributes = { ...node.attributes };
    for (const [key, value] of Object.entries(attributes)) {
      if (!parseV5aKey(key) || !isTypedPropertyValue(value)) continue;
      try { validatePropertyDataType(value.value, value.type); }
      catch (error) {
        delete attributes[key];
        onReject(`Rejected room property ${node.path} ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ...node, attributes };
  }) };
}
