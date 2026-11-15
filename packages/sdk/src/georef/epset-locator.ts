/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the convention sets (`ePSet_MapConversion` / `ePSet_ProjectedCRS`) are.
 *
 * The reader (`georef-epset.ts`) takes the first property set of that name ANYWHERE in the file, on any host or
 * on none. A writer that only looks on IfcSite, IfcProject and IfcBuilding (the hosts the convention names, and
 * the ones files in the wild use) would leave such a set behind, still read as the georeferencing: so a set the
 * writer cannot account for is reported here and the write refuses naming it. Cheap by design: names and
 * relationships of source property sets are read once per store, and only when a set of that name exists.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EffectiveEntities } from './effective-entities.js';

const NAMES = ['epset_mapconversion', 'epset_projectedcrs'];

interface SourceSets {
  /** Source property sets that carry a convention name. */
  named: Map<number, string>;
  /** Source IfcRelDefinesByProperties: the objects each relates to the set it names. */
  rels: Array<{ id: number; hosts: number[]; set: number }> | null;
}
const cache = new WeakMap<IfcDataStore, SourceSets>();

// @raw-entity-enumeration-ok point read of one source record selected from the cached source class lists below
const sourceRef = (store: IfcDataStore, id: number) => store.entityIndex?.byId.get(id);

function sourceSets(store: IfcDataStore): SourceSets {
  let sets = cache.get(store);
  if (sets) return sets;
  sets = { named: new Map(), rels: null };
  const extractor = store.source?.length ? new EntityExtractor(store.source) : null;
  // @raw-entity-enumeration-ok immutable source membership, cached per store; tombstones and creations are applied by the caller
  for (const id of store.entityIndex?.byType.get('IFCPROPERTYSET') ?? []) {
    const ref = sourceRef(store, id);
    const name = ref && extractor?.extractEntity(ref)?.attributes?.[2];
    if (typeof name === 'string' && NAMES.includes(name.toLowerCase())) sets.named.set(id, name);
  }
  cache.set(store, sets);
  return sets;
}

function sourceRels(store: IfcDataStore, sets: SourceSets): NonNullable<SourceSets['rels']> {
  if (sets.rels) return sets.rels;
  const extractor = store.source?.length ? new EntityExtractor(store.source) : null;
  sets.rels = [];
  // @raw-entity-enumeration-ok immutable source relationships, cached per store; deletions and creations are applied by the caller
  for (const id of store.entityIndex?.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
    const ref = sourceRef(store, id);
    const attrs = ref && extractor?.extractEntity(ref)?.attributes;
    if (attrs && typeof attrs[5] === 'number') sets.rels.push({ id, hosts: (Array.isArray(attrs[4]) ? attrs[4] : []).filter((h): h is number => typeof h === 'number'), set: attrs[5] });
  }
  return sets.rels;
}

/** Convention sets no host the writer manages carries, as messages for `facts.unknown`. */
export function strayConventionSets(store: IfcDataStore, view: MutablePropertyView, effective: EffectiveEntities, managedHosts: ReadonlySet<number>): string[] {
  const sets = sourceSets(store);
  const candidates = new Map<number, string>();
  for (const [id, name] of sets.named) if (!view.isDeleted(id)) candidates.set(id, name);
  for (const id of effective.idsOf('IFCPROPERTYSET')) {
    if (sets.named.has(id) || candidates.has(id)) continue;
    const read = effective.attributesOf(id);
    const name = 'attributes' in read ? read.attributes[2] : undefined;
    if (typeof name === 'string' && NAMES.includes(name.toLowerCase())) candidates.set(id, name);
  }
  if (candidates.size === 0) return [];
  const rels = sourceRels(store, sets).filter((r) => !view.isDeleted(r.id)).map(({ hosts, set }) => ({ hosts, set }));
  for (const id of effective.idsOf('IFCRELDEFINESBYPROPERTIES')) {
    const read = effective.attributesOf(id);
    if ('attributes' in read && typeof read.attributes[5] === 'number' && !sets.rels?.some((r) => r.id === id)) {
      rels.push({ hosts: (Array.isArray(read.attributes[4]) ? read.attributes[4] : []).filter((h): h is number => typeof h === 'number'), set: read.attributes[5] });
    }
  }
  const stray: string[] = [];
  for (const [id, name] of candidates) {
    const hosts = rels.filter((r) => r.set === id).flatMap((r) => r.hosts);
    if (hosts.length === 0) stray.push(`${name} #${id} is not attached to any object`);
    for (const host of new Set(hosts)) {
      if (!managedHosts.has(host) && view.getForEntity(host).some((p) => p.name === name)) stray.push(`${name} #${id} is attached to #${host}, which is not an IfcSite, IfcProject or IfcBuilding`);
    }
  }
  return stray;
}
