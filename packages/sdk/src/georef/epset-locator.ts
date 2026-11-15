/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which convention sets (`ePSet_MapConversion` / `ePSet_ProjectedCRS`) the exported file will contain, and which
 * one the reader will take. One function for facts, trust and `get()`.
 *
 * The reader (`georef-epset.ts`) takes the first property set of that name ANYWHERE in the file, on any host or
 * on none, in the file's own order. So every copy counts, whatever carries it: source sets (found through their
 * relationships), sets the property API created or edited on any host, and unattached ones. A copy on an object
 * other than IfcSite, IfcProject or IfcBuilding is not `managed`: a write replaces or removes it like any other.
 *
 * Order is predictable only for sets the session did not touch (the reader's file order is the source id order).
 * An edited or created set is re-emitted with a new id, so when a name has several copies and any was edited or
 * created, which one the reader takes is not known: that is reported in `ambiguous`, never guessed.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { effectiveEntities, type EffectiveEntities } from './effective-entities.js';
import type { EPSetLocation } from './model-facts.js';

const NAMES = ['epset_mapconversion', 'epset_projectedcrs'];
const isConvention = (name: string | undefined) => !!name && NAMES.includes(name.toLowerCase());

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
    if (typeof name === 'string' && isConvention(name)) sets.named.set(id, name);
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

/** An unattached source set's properties, name → value, read from the file. */
function sourceValues(store: IfcDataStore, id: number): Record<string, unknown> {
  const extractor = store.source?.length ? new EntityExtractor(store.source) : null;
  const props = extractor && sourceRef(store, id) ? extractor.extractEntity(sourceRef(store, id)!)?.attributes?.[4] : null;
  const values: Record<string, unknown> = {};
  for (const p of Array.isArray(props) ? props : []) {
    const ref = typeof p === 'number' ? sourceRef(store, p) : undefined;
    const attrs = ref && extractor?.extractEntity(ref)?.attributes;
    if (attrs && typeof attrs[0] === 'string') values[attrs[0]] = Array.isArray(attrs[2]) ? attrs[2][1] : attrs[2];
  }
  return values;
}

export interface ConventionSets {
  /** Every copy the exported file will contain, in the order the reader would meet them where that is known. */
  copies: EPSetLocation[];
  /** The copy the reader takes for each set, when it is known which. */
  mapConversion: EPSetLocation | null;
  projectedCRS: EPSetLocation | null;
  /** Names with several copies where the session edited or created one: the reader's choice is not known. */
  ambiguous: string[];
  /** The session changed something the sets are read from (a property, a whole set, or a set's own name). */
  touched: boolean;
}

export function locateConventionSets(store: IfcDataStore, view: MutablePropertyView, effective: EffectiveEntities, managedHosts: ReadonlySet<number>): ConventionSets {
  const sets = sourceSets(store);
  const allChanges = view.getEffectiveChanges();
  const changes = allChanges.filter((c) => isConvention(c.setName));
  const edited = new Set(changes.map((c) => `${c.entityId}|${c.setName!.toLowerCase()}`));

  // A set's name is its record's: read it from the effective record, so a rename out (`Pset_Other`) removes the copy
  // and a rename in (an unrelated set becomes `ePSet_MapConversion`) adds one, by name or by position alike.
  const isPset = (id: number) => (sourceRef(store, id)?.type ?? view.getNewEntity(id)?.type ?? '').toUpperCase() === 'IFCPROPERTYSET';
  const renamed = new Set(allChanges.filter((c) => c.kind === 'attribute' && (c.name === 'Name' || c.name === '@2') && isPset(c.entityId)).map((c) => c.entityId));
  const effectiveName = (id: number) => { const read = effective.attributesOf(id); return 'attributes' in read && typeof read.attributes[2] === 'string' ? read.attributes[2] : undefined; };
  const renamedOut = new Set<number>();
  const renamedIn = new Map<number, string>();
  for (const id of renamed) {
    if (view.isDeleted(id)) continue;
    const name = effectiveName(id);
    if (sets.named.has(id) && !isConvention(name)) renamedOut.add(id);
    else if (!sets.named.has(id) && isConvention(name)) renamedIn.set(id, name!);
  }

  // Source and created property sets by id, and the objects each hangs off.
  const named = new Map<number, string>();
  for (const [id, name] of sets.named) if (!view.isDeleted(id) && !renamedOut.has(id)) named.set(id, name);
  for (const [id, name] of renamedIn) named.set(id, name);
  for (const id of effective.idsOf('IFCPROPERTYSET')) {
    if (named.has(id) || sets.named.has(id) || renamedIn.has(id)) continue;
    const name = effectiveName(id);
    if (typeof name === 'string' && isConvention(name)) named.set(id, name);
  }
  const rels: Array<{ hosts: number[]; set: number }> = [];
  if (named.size > 0 || renamedOut.size > 0) {
    for (const r of sourceRels(store, sets)) if (!view.isDeleted(r.id)) rels.push(r);
    for (const id of effective.idsOf('IFCRELDEFINESBYPROPERTIES')) {
      const read = effective.attributesOf(id);
      if ('attributes' in read && typeof read.attributes[5] === 'number' && !sets.rels?.some((r) => r.id === id)) {
        rels.push({ hosts: (Array.isArray(read.attributes[4]) ? read.attributes[4] : []).filter((h): h is number => typeof h === 'number'), set: read.attributes[5] });
      }
    }
  }

  const hosts = new Set<number>([...managedHosts, ...changes.map((c) => c.entityId)]);
  const sourceIdsOn = new Map<string, number[]>();
  const attached = new Set<number>();
  // The view lists a host's source sets under the names the file gave them, in source order: a set renamed out is still
  // in that list, and its slot is skipped below so that the copies line up with the records the file will contain.
  for (const [id, name] of [...sets.named, ...renamedIn].sort((a, b) => a[0] - b[0])) {
    if (view.isDeleted(id)) continue;
    for (const host of new Set(rels.filter((r) => r.set === id).flatMap((r) => r.hosts))) {
      hosts.add(host);
      attached.add(id);
      const key = `${host}|${name.toLowerCase()}`;
      sourceIdsOn.set(key, [...(sourceIdsOn.get(key) ?? []), id]);
    }
  }

  const copies: Array<EPSetLocation & { order: number }> = [];
  for (const host of hosts) {
    const seen = new Map<string, number>();
    for (const pset of view.getForEntity(host)) {
      const key = `${host}|${pset.name.toLowerCase()}`;
      if (!isConvention(pset.name)) continue;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const values: Record<string, unknown> = {};
      for (const prop of pset.properties) values[prop.name] = prop.value;
      const backing = sourceIdsOn.get(key)?.[n];
      if (backing !== undefined && renamedOut.has(backing)) continue;
      const wasEdited = edited.has(key);
      copies.push({ hostId: host, name: pset.name, values, managed: managedHosts.has(host), edited: wasEdited, order: wasEdited ? Infinity : (backing ?? Infinity) });
    }
  }
  // A set renamed into a convention name: the view still lists it under its old name, so it is read from its record.
  for (const [id, name] of renamedIn) {
    const on = [...new Set(rels.filter((r) => r.set === id).flatMap((r) => r.hosts))];
    for (const host of on.length > 0 ? on : [0]) {
      copies.push({ hostId: host, ...(on.length === 0 ? { orphan: id } : {}), name, values: sourceValues(store, id), managed: managedHosts.has(host), edited: true, order: Infinity });
    }
  }
  // A set no relationship attaches to anything: the reader still takes it.
  for (const [id, name] of named) {
    if (!attached.has(id) && !renamedIn.has(id)) copies.push({ hostId: 0, orphan: id, name, values: sourceValues(store, id), managed: false, edited: false, order: id });
  }

  const ambiguous: string[] = [];
  const pick = (kind: string): EPSetLocation | null => {
    const of = copies.filter((c) => c.name.toLowerCase() === kind).sort((a, b) => a.order - b.order);
    if (of.length > 1 && of.some((c) => c.edited || c.order === Infinity)) {
      ambiguous.push(`${of.length} copies of ${of[0].name} (${of.map(describeSet).join(', ')}) and one was edited or created, so which one the file reads first is not known`);
    }
    return of[0] ?? null;
  };
  const mapConversion = pick(NAMES[0]);
  const projectedCRS = pick(NAMES[1]);
  return { copies, mapConversion, projectedCRS, ambiguous, touched: changes.length > 0 || renamedOut.size > 0 || renamedIn.size > 0 };
}

/** `ePSet_MapConversion on #8` / `ePSet_MapConversion #103 (not attached to any object)`. */
export function describeSet(p: EPSetLocation): string {
  return p.orphan === undefined ? `${p.name} on #${p.hostId}` : `${p.name} #${p.orphan} (not attached to any object)`;
}

const NONE: ConventionSets = { copies: [], mapConversion: null, projectedCRS: null, ambiguous: [], touched: false };

/** `locateConventionSets` for a caller without facts; instant when the file has no convention set and the session touched none. */
export function conventionSetsOf(store: IfcDataStore, view: MutablePropertyView): ConventionSets {
  if (sourceSets(store).named.size === 0 && !view.hasPendingChanges()) return NONE;
  const effective = effectiveEntities(store, view);
  return locateConventionSets(store, view, effective, new Set(['IFCSITE', 'IFCPROJECT', 'IFCBUILDING'].flatMap((t) => effective.idsOf(t))));
}
