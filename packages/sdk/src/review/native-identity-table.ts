/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { NativeReviewModel } from './capture-types.js';

/** Actual row identities, including duplicates hidden by point-lookup maps.
 * This captures physical references, not a copied table or a mutation editor.
 * Readers bound enumeration and revalidate these references after source awaits.
 */
export function createNativeReviewIdentityTable(
  store: Pick<IfcDataStore, 'entities' | 'strings'>,
): NonNullable<NativeReviewModel['identityTable']> {
  const owner = store.entities, stringTable = store.strings;
  const expressIdColumn = owner.expressId, GlobalIdColumn = owner.globalId, count = owner.count;
  return {
    owner, expressIdColumn, GlobalIdColumn, stringTable, count,
    *rows() {
      if (!Number.isSafeInteger(count) || count < 0 || count > expressIdColumn.length || count > GlobalIdColumn.length) {
        throw new Error('Columnar Review identities are unavailable');
      }
      for (let row = 0; row < count; row++) {
        const stringIndex = GlobalIdColumn[row];
        // NULL_INDEX is -1, encoded by the existing Uint32 column as 0xFFFFFFFF.
        // Other invalid indexes must not be silently folded into a missing GUID.
        if (stringIndex !== 0xFFFFFFFF && stringIndex >= stringTable.count) {
          throw new Error('Columnar Review identities are unavailable');
        }
        yield { expressId: expressIdColumn[row], GlobalId: stringTable.get(stringIndex) };
      }
    },
  };
}
