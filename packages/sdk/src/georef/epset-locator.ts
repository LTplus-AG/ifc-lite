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

const NAMES = Object.freeze(['epset_mapconversion', 'epset_projectedcrs']);
const NUMERIC = Object.freeze(['Eastings', 'Northings', 'OrthogonalHeight', 'XAxisAbscissa', 'XAxisOrdinate', 'Scale']);
/** A number as the reader reads one: a finite number, or text that is one (some writers store Eastings as text). */
export function decodeNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
const isConvention = (name: string | undefined) => !!name && NAMES.includes(name.toLowerCase());

interface SourceSets {
  /** Source property sets that carry a convention name. */
  named: Map<number, string>;
  /** Their GlobalIds: the view's entries name the set they come from by it, whatever order it lists them in. */
  byGlobalId: Map<string, number>;
  /** GlobalId of each source set, and the ones two source sets share: an entry carrying one of those cannot be matched to a record. */
  gidOf: Map<number, string>;
  dupGids: Set<string>;
  /** The IfcPropertySingleValue records those sets list: a rename of one changes what the reader finds. */
  atoms: Set<number>;
  /** Source IfcRelDefinesByProperties: the objects each relates to the set it names. */
  rels: Map<number, Array<{ id: number; hosts: number[] }>> | null;
}
const cache = new WeakMap<IfcDataStore, SourceSets>();

// @raw-entity-enumeration-ok point read of one source record selected from the cached source class lists below
const sourceRef = (store: IfcDataStore, id: number) => store.entityIndex?.byId.get(id);

function sourceSets(store: IfcDataStore): SourceSets {
  let sets = cache.get(store);
  if (sets) return sets;
  sets = { named: new Map(), byGlobalId: new Map(), gidOf: new Map(), dupGids: new Set(), atoms: new Set(), rels: null };
  const extractor = store.source?.length ? new EntityExtractor(store.source) : null;
  // @raw-entity-enumeration-ok immutable source membership, cached per store; tombstones and creations are applied by the caller
  for (const id of store.entityIndex?.byType.get('IFCPROPERTYSET') ?? []) {
    const ref = sourceRef(store, id);
    const attrs = ref && extractor?.extractEntity(ref)?.attributes;
    if (attrs && typeof attrs[2] === 'string' && isConvention(attrs[2])) {
      sets.named.set(id, attrs[2]);
      if (typeof attrs[0] === 'string') {
        if (sets.byGlobalId.has(attrs[0])) sets.dupGids.add(attrs[0]);
        sets.byGlobalId.set(attrs[0], id);
        sets.gidOf.set(id, attrs[0]);
      }
      for (const atom of Array.isArray(attrs[4]) ? attrs[4] : []) if (typeof atom === 'number') sets.atoms.add(atom);
    }
  }
  cache.set(store, sets);
  return sets;
}

/** The source IfcRelDefinesByProperties indexed by the set each names, built once per store, so a call looks up the few sets it cares about. */
function sourceRels(store: IfcDataStore, sets: SourceSets): NonNullable<SourceSets['rels']> {
  if (sets.rels) return sets.rels;
  const extractor = store.source?.length ? new EntityExtractor(store.source) : null;
  sets.rels = new Map();
  // @raw-entity-enumeration-ok immutable source relationships, cached per store; deletions and creations are applied by the caller
  for (const id of store.entityIndex?.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
    const ref = sourceRef(store, id);
    const attrs = ref && extractor?.extractEntity(ref)?.attributes;
    if (attrs && typeof attrs[5] === 'number') {
      let bucket = sets.rels.get(attrs[5]);
      if (!bucket) sets.rels.set(attrs[5], (bucket = []));
      bucket.push({ id, hosts: (Array.isArray(attrs[4]) ? attrs[4] : []).filter((h): h is number => typeof h === 'number') });
    }
  }
  return sets.rels;
}

/** A set's properties, name → value, read from the effective records (created or source, edits applied). */
function recordValues(effective: EffectiveEntities, id: number): Record<string, unknown> {
  const read = effective.attributesOf(id);
  const props = 'attributes' in read ? read.attributes[4] : undefined;
  const values: Record<string, unknown> = {};
  for (const p of Array.isArray(props) ? props : []) {
    const atom = typeof p === 'number' ? effective.attributesOf(p) : undefined;
    if (atom && 'attributes' in atom && typeof atom.attributes[0] === 'string') values[atom.attributes[0]] = Array.isArray(atom.attributes[2]) ? atom.attributes[2][1] : atom.attributes[2];
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
    const was = sets.named.get(id);
    if (was !== undefined && !isConvention(name)) renamedOut.add(id);
    else if (was !== undefined && name!.toLowerCase() !== was.toLowerCase()) { renamedOut.add(id); renamedIn.set(id, name!); }
    else if (was === undefined && isConvention(name)) renamedIn.set(id, name!);
  }

  // Source and created property sets by id, and the objects each hangs off.
  const named = new Map<number, string>();
  for (const [id, name] of sets.named) if (!view.isDeleted(id) && !renamedOut.has(id)) named.set(id, name);
  for (const [id, name] of renamedIn) named.set(id, name);
  // Only what the session created is scanned here: the source's sets and relationships are cached, and walking every
  // set and relationship of a large model on each call would make this cost grow with the model.
  const created = (type: string) => view.getNewEntities().filter((e) => !view.isDeleted(e.expressId) && (view.getEntityTypeMutation(e.expressId)?.newType ?? e.type).toUpperCase() === type).map((e) => e.expressId);
  let createdTouch = false; // the session created a convention set, or a relationship that attaches one
  for (const id of created('IFCPROPERTYSET')) {
    const name = effectiveName(id);
    if (!named.has(id) && typeof name === 'string' && isConvention(name)) { named.set(id, name); createdTouch = true; }
  }
  const rels: Array<{ hosts: number[]; set: number }> = [];
  if (named.size > 0 || renamedOut.size > 0) {
    const bySet = sourceRels(store, sets);
    for (const id of new Set([...named.keys(), ...renamedOut, ...sets.named.keys()])) for (const r of bySet.get(id) ?? []) if (!view.isDeleted(r.id)) rels.push({ hosts: r.hosts, set: id });
    for (const id of created('IFCRELDEFINESBYPROPERTIES')) {
      const read = effective.attributesOf(id);
      if ('attributes' in read && typeof read.attributes[5] === 'number') {
        if (named.has(read.attributes[5])) createdTouch = true;
        rels.push({ hosts: (Array.isArray(read.attributes[4]) ? read.attributes[4] : []).filter((h): h is number => typeof h === 'number'), set: read.attributes[5] });
      }
    }
  }

  const hosts = new Set<number>([...managedHosts, ...changes.map((c) => c.entityId)]);
  const attached = new Set<number>();
  for (const r of rels) {
    for (const host of new Set(r.hosts)) {
      hosts.add(host);
      if (named.has(r.set)) attached.add(r.set);
    }
  }
  // The exporter writes the records in id order, so the first set of a name in the exported file is the lowest id; a
  // reader of the SOURCE meets them in file order. Both ranks are kept: where they disagree the answer differs by file.
  const rank = new Map([...sets.named.keys()].map((id, i) => [id, i] as const));

  const copies: Array<EPSetLocation & { order: number; fileRank: number }> = [];
  for (const host of hosts) {
    for (const pset of view.getForEntity(host)) {
      const key = `${host}|${pset.name.toLowerCase()}`;
      if (!isConvention(pset.name)) continue;
      const values: Record<string, unknown> = {};
      for (const prop of pset.properties) values[prop.name] = prop.value;
      // The set this entry comes from, by its GlobalId (the view's order is not the file's): a set renamed out is still
      // listed, and is skipped so that the copies are the records the file will contain.
      const backing = pset.globalId ? sets.byGlobalId.get(pset.globalId) : undefined;
      if (backing !== undefined && (renamedOut.has(backing) || view.isDeleted(backing))) continue;
      const wasEdited = edited.has(key);
      copies.push({ hostId: host, name: pset.name, values, managed: managedHosts.has(host), edited: wasEdited, order: wasEdited || backing === undefined ? Infinity : backing, fileRank: backing === undefined ? Infinity : (rank.get(backing) ?? Infinity) });
    }
  }
  // A set renamed into a convention name: the view still lists it under its old name, so it is read from its record.
  for (const [id, name] of renamedIn) {
    const on = [...new Set(rels.filter((r) => r.set === id).flatMap((r) => r.hosts))];
    for (const host of on.length > 0 ? on : [0]) {
      copies.push({ hostId: host, ...(on.length === 0 ? { orphan: id } : {}), name, values: recordValues(effective, id), managed: managedHosts.has(host), edited: true, order: Infinity, fileRank: Infinity });
    }
  }
  // A set no relationship attaches to anything: the reader still takes it.
  for (const [id, name] of named) {
    if (!attached.has(id) && !renamedIn.has(id)) copies.push({ hostId: 0, orphan: id, name, values: recordValues(effective, id), managed: false, edited: false, order: sets.named.has(id) ? id : Infinity, fileRank: rank.get(id) ?? Infinity });
  }

  const ambiguous: string[] = [];
  const pick = (kind: string): EPSetLocation | null => {
    const of = copies.filter((c) => c.name.toLowerCase() === kind).sort((a, b) => a.order - b.order);
    if (of.length > 1 && of.some((c) => c.edited || c.order === Infinity)) {
      ambiguous.push(`${of.length} copies of ${of[0].name} (${of.map(describeSet).join(', ')}) and one was edited or created, so which one the file reads first is not known`);
    }
    const byFile = [...of].sort((a, b) => a.fileRank - b.fileRank);
    if (of.length > 1 && byFile[0] !== of[0] && Number.isFinite(byFile[0].fileRank) && Number.isFinite(of[0].order)) {
      ambiguous.push(`${of.length} copies of ${of[0].name} (${of.map(describeSet).join(', ')}) sit in the file in a different order than their ids, and the exporter writes them by id: which one is read first differs between this file and its export`);
    }
    return of[0] ?? null;
  };
  // Entries of the view are matched to their records by GlobalId; a set whose removal the view does not show (renamed out
  // or deleted) must be matchable, or its copy would stay.
  for (const id of [...renamedOut, ...[...sets.named.keys()].filter((i) => view.isDeleted(i))]) {
    const gid = sets.gidOf.get(id);
    if (gid === undefined || sets.dupGids.has(gid)) ambiguous.push(`set #${id} has ${gid === undefined ? 'no GlobalId' : 'a GlobalId another set shares'}, so its removal cannot be matched to the view's entry`);
  }
  const mapConversion = pick(NAMES[0]);
  const projectedCRS = pick(NAMES[1]);
  // A value the reader would not read as a number (`abc` where Eastings belongs) is not a state anyone can state.
  for (const [field, value] of Object.entries(mapConversion?.values ?? {})) {
    if (NUMERIC.includes(field) && decodeNumber(value) === undefined) ambiguous.push(`${field} of ${describeSet(mapConversion!)} is ${JSON.stringify(value)}, which is not a number`);
  }
  // A property record of a convention set renamed, retyped or deleted through the generic API is not a property edit.
  // The rest of the subgraph the export of a convention set serializes, none of which is interpreted: a set's class,
  // its membership (`HasProperties`) and other attributes, its properties' records, and the relationships that attach it.
  // (A set's NAME is read from its record above, and a deleted set's copies are skipped.)
  const relIds = new Set(sets.named.size > 0 ? [...sets.named.keys()].flatMap((id) => (sourceRels(store, sets).get(id) ?? []).map((r) => r.id)) : []);
  const subgraphEdits = allChanges.filter((c) => {
    if (c.kind === 'property' || c.kind === 'quantity' || c.kind === 'pset-added' || c.kind === 'pset-deleted' || c.kind === 'qset-added' || c.kind === 'qset-deleted') return false;
    if (sets.atoms.has(c.entityId) || relIds.has(c.entityId)) return true;
    if (!sets.named.has(c.entityId) && !renamedIn.has(c.entityId)) return false;
    return c.kind === 'type' || (c.kind === 'attribute' && c.name !== 'Name' && c.name !== '@2');
  });
  if (subgraphEdits.length > 0) ambiguous.push(`record(s) ${[...new Set(subgraphEdits.map((c) => `#${c.entityId}`))].join(', ')} of a convention set (its class, members, properties or relationships) were changed outside bim.georef`);
  return { copies, mapConversion, projectedCRS, ambiguous, touched: changes.length > 0 || renamedOut.size > 0 || renamedIn.size > 0 || subgraphEdits.length > 0 || createdTouch };
}

/** `ePSet_MapConversion on #8` / `ePSet_MapConversion #103 (not attached to any object)`. */
export function describeSet(p: EPSetLocation): string {
  return p.orphan === undefined ? `${p.name} on #${p.hostId}` : `${p.name} #${p.orphan} (not attached to any object)`;
}

/** Shared and frozen: a caller that needs to change a result builds its own. */
const NONE: ConventionSets = Object.freeze({ copies: Object.freeze([]) as unknown as EPSetLocation[], mapConversion: null, projectedCRS: null, ambiguous: Object.freeze([]) as unknown as string[], touched: false });

/** `locateConventionSets` for a caller without facts; instant when the file has no convention set and the session touched none. */
export function conventionSetsOf(store: IfcDataStore, view: MutablePropertyView): ConventionSets {
  if (sourceSets(store).named.size === 0 && !view.hasPendingChanges()) return NONE;
  const effective = effectiveEntities(store, view);
  return locateConventionSets(store, view, effective, new Set(['IFCSITE', 'IFCPROJECT', 'IFCBUILDING'].flatMap((t) => effective.idsOf(t))));
}

/** Names with several source copies whose file order is not their id order (see `locateConventionSets`), for a session with no view yet. */
export function sourceOrderConflicts(store: IfcDataStore): string[] {
  const byName = new Map<string, number[]>();
  for (const [id, name] of sourceSets(store).named) byName.set(name.toLowerCase(), [...(byName.get(name.toLowerCase()) ?? []), id]);
  return [...byName].filter(([, ids]) => ids.length > 1 && ids[0] !== Math.min(...ids)).map(([name, ids]) => `${ids.length} copies of ${name} (${ids.map((id) => `#${id}`).join(', ')}) sit in the file in a different order than their ids, and the exporter writes them by id: which one is read first differs between this file and its export`);
}
