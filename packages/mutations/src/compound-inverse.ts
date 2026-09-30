/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Package-private touched-entry inverse. Prior unchanged graphs and journal
 * prefixes must never be retained once per operation (#6232 D5). */
import type { OverlaySnapshot } from './cooperative-overlay-access.js';
import { sameOverlayValue } from './overlay-value-equality.js';
import type { Mutation } from './types.js';

type MapField = { [K in keyof OverlaySnapshot]: OverlaySnapshot[K] extends Map<infer _Key, infer _Value> ? K : never }[keyof OverlaySnapshot];
type SetField = { [K in keyof OverlaySnapshot]: OverlaySnapshot[K] extends Set<infer _Value> ? K : never }[keyof OverlaySnapshot];
interface Entry { key: unknown; present: boolean; value?: unknown; nested?: ValueInverse }
type CollectionInverse = { kind: 'map'; entries: Entry[] }
  | { kind: 'set'; entries: Array<{ key: unknown; present: boolean }> };
type ValueInverse = CollectionInverse | { kind: 'object'; entries: Entry[] }
  | { kind: 'array'; entries: Entry[]; length: number };

function entryInverse(key: unknown, present: boolean, old: unknown, next: unknown, depth: number): Entry {
  if (depth > 64) throw new Error('Compound inverse nesting exceeds its supported depth');
  if ((old instanceof Map && next instanceof Map) || (old instanceof Set && next instanceof Set)) {
    return { key, present, nested: collectionInverse(old, next, depth + 1) };
  }
  const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if ((Array.isArray(old) && Array.isArray(next)) || (plain(old) && plain(next))) {
    const a = old as Record<string, unknown>, b = next as Record<string, unknown>;
    const entries: Entry[] = [];
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (Object.hasOwn(a, field) !== Object.hasOwn(b, field) || !sameOverlayValue(a[field], b[field])) {
        entries.push(entryInverse(field, Object.hasOwn(a, field), a[field], b[field], depth + 1));
      }
    }
    return { key, present, nested: Array.isArray(old) ? { kind: 'array', entries, length: old.length } : { kind: 'object', entries } };
  }
  return { key, present, value: structuredClone(old) };
}

function restoreValue(target: unknown, inverse: ValueInverse): void {
  if (inverse.kind === 'map' || inverse.kind === 'set') {
    if (!(target instanceof Map) && !(target instanceof Set)) throw new Error('Overlay collection changed before undo');
    restoreCollection(target, inverse);
    return;
  }
  if (!target || typeof target !== 'object' || (inverse.kind === 'array' && !Array.isArray(target))) {
    throw new Error('Overlay value changed before undo');
  }
  const object = target as Record<string, unknown>;
  for (const entry of inverse.entries) {
    const key = entry.key as string;
    if (entry.nested) restoreValue(object[key], entry.nested);
    else if (entry.present) Object.defineProperty(object, key, { value: structuredClone(entry.value), enumerable: true, writable: true, configurable: true });
    else delete object[key];
  }
  if (inverse.kind === 'array') (target as unknown[]).length = inverse.length;
}

function collectionInverse(old: Map<unknown, unknown> | Set<unknown>, next: Map<unknown, unknown> | Set<unknown>, depth = 0): CollectionInverse {
  if (old instanceof Set && next instanceof Set) {
    return { kind: 'set', entries: [...new Set([...old, ...next])].filter(key => old.has(key) !== next.has(key))
      .map(key => ({ key, present: old.has(key) })) };
  }
  if (!(old instanceof Map) || !(next instanceof Map)) throw new Error('Overlay collection type changed');
  const entries: Entry[] = [];
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const a: unknown = old.get(key), b: unknown = next.get(key);
    if (old.has(key) === next.has(key) && sameOverlayValue(a, b)) continue;
    entries.push(entryInverse(key, old.has(key), a, b, depth + 1));
  }
  return { kind: 'map', entries };
}

function restoreCollection(target: Map<unknown, unknown> | Set<unknown>, inverse: CollectionInverse): void {
  if (target instanceof Set && inverse.kind === 'set') {
    for (const entry of inverse.entries) {
      if (entry.present) target.add(entry.key);
      else target.delete(entry.key);
    }
  } else if (target instanceof Map && inverse.kind === 'map') {
    for (const entry of inverse.entries) {
      if (entry.nested) {
        const child: unknown = target.get(entry.key);
        restoreValue(child, entry.nested);
      } else if (entry.present) target.set(entry.key, structuredClone(entry.value));
      else target.delete(entry.key);
    }
  } else throw new Error('Overlay collection changed before undo');
}
export interface CompoundInverse {
  maps: Array<{ field: MapField; entries: Entry[] }>;
  sets: Array<{ field: SetField; entries: Array<{ key: unknown; present: boolean }> }>;
  historyLength: number;
  history: Array<{ index: number; mutation: Mutation }>;
}

export function captureCompoundInverse(before: OverlaySnapshot, after: OverlaySnapshot): CompoundInverse {
  const inverse: CompoundInverse = { maps: [], sets: [], historyLength: before.mutationHistory.length, history: [] };
  for (const field of Object.keys(before) as Array<keyof OverlaySnapshot>) {
    const old = before[field], next = after[field];
    if (old instanceof Map && next instanceof Map) {
      const inverseMap = collectionInverse(old as Map<unknown, unknown>, next as Map<unknown, unknown>);
      if (inverseMap.kind !== 'map') throw new Error('Expected an overlay map');
      const entries = inverseMap.entries;
      if (entries.length) inverse.maps.push({ field: field as MapField, entries });
    } else if (old instanceof Set && next instanceof Set) {
      const a = old as Set<unknown>, b = next as Set<unknown>;
      const entries = [...new Set([...a, ...b])].filter(key => a.has(key) !== b.has(key))
        .map(key => ({ key, present: a.has(key) }));
      if (entries.length) inverse.sets.push({ field: field as SetField, entries });
    }
  }
  const remaining = new Map(after.mutationHistory.map(m => [m.id, m]));
  before.mutationHistory.forEach((mutation, index) => {
    if (!sameOverlayValue(mutation, remaining.get(mutation.id))) inverse.history.push({ index, mutation: structuredClone(mutation) });
  });
  return inverse;
}

export function restoreCompoundInverse(state: OverlaySnapshot, inverse: CompoundInverse, writtenCount: number): void {
  for (const { field, entries } of inverse.maps) {
    const map = state[field] as Map<unknown, unknown>;
    restoreCollection(map, { kind: 'map', entries });
  }
  for (const { field, entries } of inverse.sets) {
    const set = state[field] as Set<unknown>;
    for (const entry of entries) {
      if (entry.present) set.add(entry.key);
      else set.delete(entry.key);
    }
  }
  state.mutationHistory = state.mutationHistory.slice(0, -writtenCount);
  for (const { index, mutation } of inverse.history) {
    const existing = state.mutationHistory.findIndex(m => m.id === mutation.id);
    if (existing >= 0) state.mutationHistory.splice(existing, 1);
    state.mutationHistory.splice(index, 0, structuredClone(mutation));
  }
  if (state.mutationHistory.length !== inverse.historyLength) throw new Error('Compound history changed; cannot restore its journal');
  // Preserve the current allocator: undo never permits express ID reuse.
}
