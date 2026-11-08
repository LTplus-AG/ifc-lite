/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Detached synchronous drafts: copy values on first read, publish only changed
 * entries. Neither transaction setup nor an append visits the session prefix. */
import { NewEntityMap } from './new-entity-map.js';
import { sameOverlayValue } from './overlay-value-equality.js';
import { captureCompoundInverse, type CompoundInverse } from './compound-inverse.js';
import type { OverlaySnapshot } from './cooperative-overlay-access.js';
import type { NewEntity } from './types.js';

type Change = { before: unknown; after: unknown; apply(): void };
const materializers = new WeakMap<object, () => object>();

/** Snapshots may still be requested explicitly inside an incremental draft. */
export function materializeOverlay(state: OverlaySnapshot): OverlaySnapshot {
  return Object.fromEntries(Object.entries(state).map(([key, value]) =>
    [key, value && typeof value === 'object' ? materializers.get(value)?.() ?? value : value])) as OverlaySnapshot;
}

function sparseMap<K, V, T extends Map<K, V>>(base: T): { value: T; changes(): Change } {
  const reads = new Map<K, V>(), removed = new Set<K>(), inserted = new Set<K>();
  const localEntities = base instanceof NewEntityMap ? new NewEntityMap() : null;
  let size = base.size;
  const has = (key: K) => inserted.has(key) || (!removed.has(key) && base.has(key));
  const get = (key: K): V | undefined => {
    if (!has(key)) return undefined;
    if (!reads.has(key)) {
      const row = structuredClone(base.get(key)!);
      reads.set(key, row);
      localEntities?.set(key as number, row as unknown as NewEntity);
    }
    return reads.get(key);
  };
  function* keys(): MapIterator<K> {
    for (const key of base.keys()) if (!removed.has(key)) yield key;
    yield* inserted;
  }
  function* entries(): MapIterator<[K, V]> { for (const key of keys()) yield [key, get(key)!]; }
  function* values(): MapIterator<V> { for (const key of keys()) yield get(key)!; }
  const target = base instanceof NewEntityMap ? new NewEntityMap() : new Map<K, V>();
  const value = new Proxy(target, { get(_target, name) {
    if (name === 'size') return size;
    if (name === 'positionOf' && base instanceof NewEntityMap) return (id: number) => base.positionOf(id);
    if (name === 'get') return get;
    if (name === 'has') return has;
    if (name === 'set') return (key: K, next: V) => {
      if (!has(key)) { size++; inserted.add(key); }
      reads.set(key, next); localEntities?.set(key as number, next as NewEntity); return value;
    };
    if (name === 'delete') return (key: K) => {
      if (!has(key)) return false;
      size--; inserted.delete(key); removed.add(key); reads.delete(key); localEntities?.delete(key as number); return true;
    };
    if (name === 'clear') return () => { for (const key of keys()) removed.add(key); inserted.clear(); reads.clear(); localEntities?.clear(); size = 0; };
    if (name === 'keys') return keys;
    if (name === 'values') return values;
    if (name === 'entries' || name === Symbol.iterator) return entries;
    if (name === 'forEach') return (fn: (v: V, k: K, map: T) => void, self?: unknown) => {
      for (const [k, v] of entries()) fn.call(self, v, k, value);
    };
    if ((name === 'ofType' || name === 'referencing') && base instanceof NewEntityMap) return function* (query: string | number): IterableIterator<NewEntity> {
      const seen = new Set<number>();
      const candidates = name === 'ofType' ? base.ofType(String(query)) : base.referencing(Number(query));
      for (const entity of candidates) {
        const key = entity.expressId as K;
        if (removed.has(key)) continue;
        const next = get(key) as NewEntity;
        // A replaced entry is checked in the private draft bucket below.
        if (name === 'ofType' ? next.type.toUpperCase() !== String(query).toUpperCase()
          : !localEntities!.referencesId(next.expressId, Number(query))) continue;
        seen.add(next.expressId); yield next;
      }
      const local = name === 'ofType' ? localEntities!.ofType(String(query)) : localEntities!.referencing(Number(query));
      for (const entity of local) if (!seen.has(entity.expressId) && has(entity.expressId as K)) yield entity;
    };
    return Reflect.get(_target, name, _target);
  } }) as T;
  materializers.set(value, () => new Map(entries()));
  return { value, changes() {
    const before = new Map<K, V>(), after = new Map<K, V>();
    const candidates = [...new Set([...reads.keys(), ...removed])];
    // Inverse replay re-inserts forgotten records. Preserve their original
    // insertion order, independently of the callback's access/delete order.
    if (base instanceof NewEntityMap) candidates.sort((a, b) => base.positionOf(a as number) - base.positionOf(b as number));
    for (const key of candidates) {
      const old = base.get(key), next = get(key);
      if (base.has(key) === has(key) && sameOverlayValue(old, next) && !removed.has(key)) continue;
      if (base.has(key)) before.set(key, structuredClone(old!));
      if (has(key)) after.set(key, structuredClone(next!));
    }
    return { before, after, apply() {
      for (const key of removed) base.delete(key);
      for (const [key, next] of after) base.set(key, structuredClone(next));
    } };
  } };
}

function sparseSet<T>(base: Set<T>): { value: Set<T>; changes(): Change } {
  const added = new Set<T>(), removed = new Set<T>();
  const has = (key: T) => added.has(key) || (!removed.has(key) && base.has(key));
  function* values(): SetIterator<T> { for (const key of base) if (!removed.has(key)) yield key; yield* added; }
  const value = new Proxy(new Set<T>(), { get(target, name) {
    if (name === 'size') return base.size - removed.size + added.size;
    if (name === 'has') return has;
    if (name === 'add') return (key: T) => { if (!has(key)) { if (base.has(key)) removed.delete(key); else added.add(key); } return value; };
    if (name === 'delete') return (key: T) => { const had = has(key); if (base.has(key)) removed.add(key); added.delete(key); return had; };
    if (name === 'clear') return () => { for (const key of base) removed.add(key); added.clear(); };
    if (name === Symbol.iterator || name === 'keys' || name === 'values') return values;
    if (name === 'entries') return function* () { for (const key of values()) yield [key, key]; };
    if (name === 'forEach') return (fn: (v: T, k: T, set: Set<T>) => void, self?: unknown) => { for (const key of values()) fn.call(self, key, key, value); };
    return Reflect.get(target, name, target);
  } });
  materializers.set(value, () => new Set(values()));
  return { value, changes: () => ({ before: new Set(removed), after: new Set(added), apply() {
    for (const key of removed) base.delete(key);
    for (const key of added) base.add(key);
  } }) };
}

/** A native array facade with a private sparse prefix and append-only tail.
 * Array methods still work normally; only methods that ask for the prefix pay
 * to visit it (delete/undo), never ordinary history appends. */
function sparseHistory(base: OverlaySnapshot['mutationHistory']) {
  const rows = new Map<number, OverlaySnapshot['mutationHistory'][number]>();
  let length = base.length;
  const get = (i: number) => {
    if (!rows.has(i) && i < base.length) rows.set(i, structuredClone(base[i]));
    return rows.get(i);
  };
  const index = (key: PropertyKey) => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : null;
  const value = new Proxy([] as OverlaySnapshot['mutationHistory'], {
    get(target, key, receiver) {
      if (key === 'length') return length;
      const i = index(key);
      return i === null ? Reflect.get(target, key, receiver) : i < length ? get(i) : undefined;
    },
    has(target, key) { const i = index(key); return i === null ? Reflect.has(target, key) : i < length; },
    ownKeys() { return [...Array.from({ length }, (_, i) => String(i)), 'length']; },
    getOwnPropertyDescriptor(target, key) {
      const i = index(key);
      return i === null ? Reflect.getOwnPropertyDescriptor(target, key)
        : i < length ? { configurable: true, enumerable: true, writable: true, value: get(i) } : undefined;
    },
    set(_target, key, next) {
      if (key === 'length') { length = Number(next); for (const i of rows.keys()) if (i >= length) rows.delete(i); return true; }
      const i = index(key);
      if (i === null) return Reflect.set(_target, key, next);
      rows.set(i, next); length = Math.max(length, i + 1); return true;
    },
    deleteProperty(_target, key) { const i = index(key); if (i !== null) rows.delete(i); return true; },
  });
  materializers.set(value, () => Array.from(value));
  return { value, rows, get };
}

export function sparseOverlay(original: OverlaySnapshot) {
  const state = { ...original };
  const fields: Array<{ key: keyof OverlaySnapshot; changes(): Change }> = [];
  for (const key of Object.keys(original) as Array<keyof OverlaySnapshot>) {
    const base = original[key];
    const draft = base instanceof Map ? sparseMap(base as Map<unknown, unknown>) : base instanceof Set ? sparseSet(base as Set<unknown>) : null;
    if (draft) {
      Object.assign(state, { [key]: draft.value });
      fields.push({ key, changes: draft.changes });
    }
  }
  const history = sparseHistory(original.mutationHistory);
  state.mutationHistory = history.value;
  return { state, finish(after: OverlaySnapshot, record: boolean) {
    const changes = fields.map(field => ({ ...field, ...field.changes() }));
    const beforeSmall = { ...original, mutationHistory: [] } as OverlaySnapshot;
    const afterSmall = { ...after, mutationHistory: [] } as OverlaySnapshot;
    for (const change of changes) {
      Object.assign(beforeSmall, { [change.key]: change.before });
      Object.assign(afterSmall, { [change.key]: change.after });
    }
    // A writer may replace a collection altogether (clear/import/undo). Diff
    // that explicit replacement; it already requested work proportional to it.
    for (const change of changes) if (after[change.key] !== state[change.key]) {
      Object.assign(beforeSmall, { [change.key]: original[change.key] });
      Object.assign(afterSmall, { [change.key]: after[change.key] });
    }
    const inverse: CompoundInverse | undefined = record ? captureCompoundInverse(beforeSmall, afterSmall) : undefined;
    const nextHistory = after.mutationHistory;
    const appendOnly = nextHistory === history.value && nextHistory.length >= original.mutationHistory.length
      && [...history.rows].every(([i, row]) => i >= original.mutationHistory.length || sameOverlayValue(row, original.mutationHistory[i]));
    let written: string[] = [];
    if (appendOnly) {
      written = nextHistory.slice(original.mutationHistory.length).map(m => m.id);
      if (inverse) inverse.historyLength = original.mutationHistory.length;
    } else if (record) {
      const old = new Set(original.mutationHistory.map(m => m.id));
      written = nextHistory.filter(m => !old.has(m.id)).map(m => m.id);
      const historyInverse = captureCompoundInverse({ ...beforeSmall, mutationHistory: original.mutationHistory }, { ...beforeSmall, mutationHistory: Array.from(nextHistory) });
      inverse!.historyLength = historyInverse.historyLength;
      inverse!.history = historyInverse.history;
    }
    // Clone all output BEFORE any publication. A failed clone is atomic too.
    const tail = appendOnly ? structuredClone(nextHistory.slice(original.mutationHistory.length)) : structuredClone(Array.from(nextHistory));
    const publication = { ...original, nextAllocatedId: after.nextAllocatedId };
    const replacements = changes.filter(c => after[c.key] !== state[c.key]).map(c => [c.key, structuredClone(after[c.key])] as const);
    return { inverse, written, changed: after.nextAllocatedId !== original.nextAllocatedId || changes.some(c => !sameOverlayValue(c.before, c.after)) || !appendOnly || tail.length > 0,
      publish() {
        for (const change of changes) if (after[change.key] === state[change.key]) change.apply();
        for (const [key, value] of replacements) Object.assign(publication, { [key]: value });
        if (appendOnly) for (const row of tail) original.mutationHistory.push(row);
        else publication.mutationHistory = tail;
        return publication;
      } };
  } };
}
