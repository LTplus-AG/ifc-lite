/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

type Read = { read: () => unknown; value: string | undefined };
type Entry = { revision: number; reads: Map<string, Read>; value: unknown };
const models = new WeakMap<IfcDataStore, WeakMap<MutablePropertyView, Map<string, Entry>>>();

function signature(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Map) return [...item];
    if (item instanceof Set) return [...item];
    return item;
  });
}

/**
 * Read-only IFC derivations (#9296). Record the overlay reads made by the real
 * reader, including absent entities and placement/representation leaves. A
 * revision change checks those reads without parsing source bytes again.
 * Undo, skipHistory, atomic publication and remote writes all advance the
 * view revision, so this does not depend on viewer history or mutationVersion.
 * Source and view identities scope the cache; closing a model releases it.
 *
 * Unfiltered creation walks inspect class membership before reading payloads.
 * `types` declares those classes; point reads still track ANY entity class.
 * Callers must not mutate returned derived values or the supplied read view.
 */
export function derivedState<T>(
  store: IfcDataStore,
  view: MutablePropertyView,
  key: string,
  types: readonly string[],
  derive: (tracked: MutablePropertyView) => T,
): T {
  let views = models.get(store);
  if (!views) models.set(store, views = new WeakMap());
  let entries = views.get(view);
  if (!entries) views.set(view, entries = new Map());
  const revision = view.getMutationRevision();
  const previous = entries.get(key);
  if (previous && (previous.revision === revision || [...previous.reads.values()].every(read => signature(read.read()) === read.value))) {
    previous.revision = revision;
    return previous.value as T;
  }
  const reads = new Map<string, Read>();
  const relevant = new Set(types.map(type => type.toUpperCase()));
  const tracked = new Proxy(view, {
    get(target, name, receiver) {
      const member: unknown = Reflect.get(target, name, receiver);
      if (typeof member !== 'function') return member;
      if (name === 'getMutationRevision') return member.bind(target);
      if (typeof name !== 'string' || !/^(get|read|is|has|peek)/.test(name)) {
        throw new Error(`Derived IFC state attempted non-read operation ${String(name)}`);
      }
      return (...args: unknown[]) => {
        const enumeration = /^(getNewEntitiesOfType|readNewEntitiesOfType|readNewEntityKinds|getNewEntitiesReferencing)$/.test(name);
        const allCreations = name === 'getNewEntities' || name === 'readNewEntities' || (name === 'readNewEntityKinds' && args[0] === undefined);
        const call = () => {
          const result: unknown = Reflect.apply(member, target, args);
          return enumeration ? Array.from(result as Iterable<unknown>) : result;
        };
        const select = (result: unknown) => allCreations
          ? (result as Array<{ type: string }>).filter(row => relevant.has(row.type.toUpperCase()))
          : result;
        const result = call();
        const id = `${name}:${JSON.stringify(args)}`;
        // Save on each read: some results retain a reader that lazily reads
        // more records after derive returns (StoreyInventory).
        reads.set(id, { read: () => select(call()), value: signature(select(result)) });
        return result;
      };
    },
    set() { throw new Error('Derived IFC state is read-only'); },
  });
  const value = derive(tracked);
  entries.set(key, { revision, reads, value });
  return value;
}
