// SPDX-License-Identifier: MPL-2.0
import type { IfcDataStore } from '@ifc-lite/parser';

/** Source-streaming invalidation tokens, independent of overlay mutations.
 * Source-only stores may omit the columnar entity table. */
export function sourceInventorySignature(store: IfcDataStore): unknown[] {
  // @raw-entity-enumeration-ok source identity and size tokens only; callers enumerate live records through AnchorEntityReader's effective accessors.
  return [store.source, store.entityIndex, store.entityIndex.byType, store.entityIndex.byId.size,
    store.deferredEntityIndex, store.deferredEntityIndex?.size, store.entities?.typeRevision, store.entities?.expressId?.length];
}
