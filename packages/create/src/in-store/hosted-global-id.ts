/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 / #6539: immutable source ownership is indexed once on demand;
 * effective ownership is always rechecked through the live overlay. */
import { getAttributeNamesForSchema, type IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { AnchorEntityReader } from './resolve-anchor.js';

interface SourceOwners {
  entities: IfcDataStore['entities'];
  byId: IfcDataStore['entityIndex']['byId'];
  schema: IfcDataStore['schemaVersion'];
  owners: Map<string, number[]>;
}
const indices = new WeakMap<IfcDataStore, SourceOwners>();

function sourceOwners(store: IfcDataStore): Map<string, number[]> {
  const cached = indices.get(store);
  // @raw-entity-enumeration-ok Cache identity compares the immutable source index; effective ownership is rechecked below.
  if (cached?.entities === store.entities && cached.byId === store.entityIndex.byId && cached.schema === store.schemaVersion) {
    return cached.owners;
  }
  // The display table's GlobalId index omits relationship GUIDs. Index ALL
  // schema-declared IfcRoot classes, never unrelated points/geometry records.
  // @raw-entity-enumeration-ok Source class keys seed the immutable IfcRoot GUID index; live retypes and creations are checked separately.
  const rootTypes = [...store.entityIndex.byType.keys()].filter(type =>
    getAttributeNamesForSchema(type, store.schemaVersion)[0] === 'GlobalId');
  const reader = new AnchorEntityReader(store, null);
  const owners = new Map<string, number[]>();
  // An empty type filter means every entity to the canonical iterator.
  const roots = rootTypes.length ? iterateEffectiveEntityIds(store, null, rootTypes) : [];
  for (const { expressId } of roots) {
    const guid = reader.entity(expressId)?.attributes[0];
    if (typeof guid !== 'string') continue;
    const ids = owners.get(guid);
    if (ids) ids.push(expressId);
    else owners.set(guid, [expressId]);
  }
  // @raw-entity-enumeration-ok Retain source-index identity only for cache invalidation, never as live session membership.
  indices.set(store, { entities: store.entities, byId: store.entityIndex.byId, schema: store.schemaVersion, owners });
  return owners;
}

/** A deleted, renamed or retyped original owner does not reserve its old
 * GUID. Live named/positional overrides and creations can introduce an owner. */
export function assertHostedGlobalIdAvailable(store: IfcDataStore, view: MutablePropertyView, globalId: string): void {
  const candidates = new Set([
    ...(sourceOwners(store).get(globalId) ?? []),
    ...view.getAttributeOverrideEntityIds(),
  ]);
  const reader = new AnchorEntityReader(store, view);
  for (const { expressId } of iterateEffectiveEntityIds(store, view, undefined, candidates)) {
    const entity = reader.entity(expressId);
    if (entity?.names[0] === 'GlobalId' && entity.attributes[0] === globalId) {
      throw new Error(`GlobalId '${globalId}' is already used by #${expressId}`);
    }
  }
}
