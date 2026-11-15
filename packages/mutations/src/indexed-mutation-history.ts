// SPDX-License-Identifier: MPL-2.0
/** Array-compatible internal journal. Bounded entity deletion uses indexed
 * rows; enumeration and explicit array rewrites still cost the rows requested. */
import type { Mutation } from './types.js';
import type { CompoundInverse } from './compound-inverse.js';
import { sameOverlayValue } from './overlay-value-equality.js';

type Node = { row: Mutation; previous: string | null; next: string | null; position: number };
const stores = new WeakMap<Mutation[], History>();
class History {
  readonly nodes = new Map<string, Node>();
  readonly entities = new Map<number, Set<string>>();
  readonly reads = new Map<string, Mutation>();
  readonly removed = new Map<string, { mutation: Mutation; beforeId: string | null }>();
  head: string | null = null;
  tail: string | null = null;
  length: number;
  position: number;
  base?: History;
  private order?: string[];
  constructor(base?: History) {
    this.base = base; this.length = base?.length ?? 0; this.position = base?.position ?? 0;
  }
  has(id: string): boolean { return this.nodes.has(id) || (!this.removed.has(id) && !!this.base?.has(id)); }
  get(id: string): Mutation {
    const own = this.nodes.get(id)?.row;
    if (own) return own;
    let row = this.reads.get(id);
    if (!row) { row = structuredClone(this.base!.get(id)); this.reads.set(id, row); }
    return row;
  }
  first(): string | null {
    let id = this.base?.first() ?? null;
    while (id !== null && this.removed.has(id)) id = this.base!.next(id);
    return id ?? this.head;
  }
  last(): string | null {
    if (this.tail !== null) return this.tail;
    let id = this.base?.last() ?? null;
    while (id !== null && this.removed.has(id)) id = this.base!.previous(id);
    return id;
  }
  next(id: string): string | null {
    const own = this.nodes.get(id);
    if (own) return own.next;
    let next = this.base?.next(id) ?? null;
    while (next !== null && this.removed.has(next)) next = this.base!.next(next);
    return next ?? this.head;
  }
  previous(id: string): string | null {
    const own = this.nodes.get(id);
    if (own?.previous) return own.previous;
    let previous = this.base ? own ? this.base.last() : this.base.previous(id) : null;
    while (previous !== null && this.removed.has(previous)) previous = this.base!.previous(previous);
    return previous;
  }
  *values(): IterableIterator<Mutation> {
    let id = this.first();
    while (id !== null) { yield this.get(id); id = this.next(id); }
  }
  append(row: Mutation): void {
    if (this.has(row.id)) throw new Error('Duplicate mutation journal identity');
    const node: Node = { row, previous: this.tail, next: null, position: ++this.position };
    if (this.tail !== null) this.nodes.get(this.tail)!.next = row.id;
    else this.head = row.id;
    this.tail = row.id; this.nodes.set(row.id, node);
    let bucket = this.entities.get(row.entityId);
    if (!bucket) this.entities.set(row.entityId, bucket = new Set());
    bucket.add(row.id); this.length++; this.order = undefined;
  }
  erase(id: string): void {
    const own = this.nodes.get(id);
    if (own) {
      if (own.previous !== null) this.nodes.get(own.previous)!.next = own.next;
      else this.head = own.next;
      if (own.next !== null) this.nodes.get(own.next)!.previous = own.previous;
      else this.tail = own.previous;
      this.nodes.delete(id);
      const bucket = this.entities.get(own.row.entityId);
      bucket?.delete(id); if (!bucket?.size) this.entities.delete(own.row.entityId);
    } else if (this.base?.has(id) && !this.removed.has(id)) {
      const next = this.next(id);
      this.removed.set(id, { mutation: structuredClone(this.base.get(id)), beforeId: next !== null && this.base.has(next) ? next : null });
      this.reads.delete(id);
    } else return;
    this.length--; this.order = undefined;
  }
  replaceRow(id: string, row: Mutation): void {
    const own = this.nodes.get(id);
    if (own) {
      if (own.row.entityId !== row.entityId) {
        const bucket = this.entities.get(own.row.entityId);
        bucket?.delete(id); if (!bucket?.size) this.entities.delete(own.row.entityId);
      }
      own.row = row;
    } else this.reads.set(id, row);
    let bucket = this.entities.get(row.entityId);
    if (!bucket) this.entities.set(row.entityId, bucket = new Set());
    bucket.add(id);
  }
  entityIds(id: number): string[] {
    const ids = new Set(this.base?.entityIds(id));
    for (const key of this.entities.get(id) ?? []) ids.add(key);
    return [...ids].filter(key => this.has(key) && this.get(key).entityId === id)
      .sort((a, b) => this.positionOf(a) - this.positionOf(b));
  }
  positionOf(id: string): number { return this.nodes.get(id)?.position ?? this.base!.positionOf(id); }
  keys(): string[] {
    if (!this.order) {
      this.order = []; let id = this.first();
      while (id !== null) { this.order.push(id); id = this.next(id); }
    }
    return this.order;
  }
  slice(start = 0, end = this.length): Mutation[] {
    const clamp = (n: number) => n < 0 ? Math.max(0, this.length + Math.trunc(n)) : Math.min(this.length, Math.trunc(n));
    start = clamp(start); end = clamp(end);
    const out: Mutation[] = [];
    if (start >= end) return out;
    // Tail reads, including transaction appends, never enumerate the prefix.
    if (this.length - start <= end) {
      let id = this.last();
      for (let i = this.length - 1; id !== null && i >= start; i--, id = this.previous(id)) if (i < end) out.push(this.get(id));
      out.reverse();
    } else {
      let id = this.first();
      for (let i = 0; id !== null && i < end; i++, id = this.next(id)) if (i >= start) out.push(this.get(id));
    }
    return out;
  }
  replace(rows: Mutation[]): void {
    this.base = undefined; this.nodes.clear(); this.entities.clear(); this.reads.clear(); this.removed.clear();
    this.head = this.tail = null; this.length = this.position = 0; this.order = undefined;
    for (const row of rows) this.append(row);
  }
}

function facade(store: History): Mutation[] {
  const target: Mutation[] = [];
  const arrayIndex = (key: PropertyKey) => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : null;
  const view = new Proxy(target, {
    get(_target, key) {
      if (key === 'length') return store.length;
      if (key === Symbol.iterator) return () => store.values();
      if (key === 'push') return (...rows: Mutation[]) => { for (const row of rows) store.append(row); return store.length; };
      if (key === 'slice') return (start?: number, end?: number) => store.slice(start, end);
      const index = arrayIndex(key);
      if (index !== null) { const id = store.keys()[index]; return id === undefined ? undefined : store.get(id); }
      const method: unknown = Reflect.get(target, key);
      if (typeof method !== 'function' || key === 'constructor') return method;
      return (...args: unknown[]) => {
        const rows = [...store.values()];
        const result: unknown = Reflect.apply(method, rows, args);
        if (['splice', 'pop', 'shift', 'unshift', 'sort', 'reverse', 'fill', 'copyWithin'].includes(String(key))) store.replace(rows);
        return result;
      };
    },
    has(_target, key) { const i = arrayIndex(key); return i === null ? Reflect.has(target, key) : i < store.length; },
    ownKeys() { return [...store.keys().map((_, i) => String(i)), 'length']; },
    getOwnPropertyDescriptor(_target, key) {
      if (key === 'length') return { value: store.length, writable: true, enumerable: false, configurable: false };
      const i = arrayIndex(key), id = i === null ? undefined : store.keys()[i];
      return id === undefined ? undefined : { value: store.get(id), writable: true, enumerable: true, configurable: true };
    },
    set(_target, key, value: unknown) {
      const rows = [...store.values()];
      const result = Reflect.set(rows, key, value); store.replace(rows); return result;
    },
    deleteProperty(_target, key) {
      const i = arrayIndex(key);
      if (i === null) return Reflect.deleteProperty(target, key);
      const id = store.keys()[i]; if (id !== undefined) store.erase(id); return true;
    },
  });
  stores.set(view, store); return view;
}

export function indexedHistory(rows: Mutation[]): Mutation[] {
  if (stores.has(rows)) return rows;
  const store = new History(); for (const row of rows) store.append(row);
  return facade(store);
}
export function materializeHistory(rows: Mutation[]): Mutation[] { return stores.has(rows) ? [...rows] : rows; }
export function historyForEntity(rows: Mutation[], entityId: number): Mutation[] {
  const store = stores.get(rows);
  return store ? store.entityIds(entityId).map(id => store.get(id)) : rows.filter(row => row.entityId === entityId);
}
export function purgeEntityHistory(rows: Mutation[], entityId: number): Mutation[] {
  const store = stores.get(rows);
  if (!store) throw new Error('Expected an indexed mutation journal');
  const removed = historyForEntity(rows, entityId);
  for (const row of removed) store.erase(row.id);
  return removed;
}
export function forkHistory(rows: Mutation[]): Mutation[] { return facade(new History(stores.get(indexedHistory(rows))!)); }

/** Returns undefined for an explicit whole-array rewrite; the existing full
 * comparison path remains appropriate for those operations (undo/import). */
export function finishHistory(original: Mutation[], next: Mutation[]) {
  const base = stores.get(original), draft = stores.get(next);
  if (!base || draft?.base !== base) return undefined;
  const changed = [...draft.reads].filter(([id, row]) => !draft.removed.has(id) && !sameOverlayValue(base.get(id), row));
  const added = [...draft.nodes.values()].map(node => structuredClone(node.row));
  const deleted = [...draft.removed];
  const updates = changed.map(([id, row]) => [id, structuredClone(row)] as const);
  const history: CompoundInverse['history'] = [
    ...deleted.map(([, row]) => ({ index: 0, mutation: row.mutation, beforeId: row.beforeId })),
    ...changed.map(([id]) => ({ index: 0, mutation: structuredClone(base.get(id)), update: true as const })),
  ];
  return {
    history, written: added.filter(row => !base.has(row.id)).map(row => row.id),
    changed: deleted.length > 0 || updates.length > 0 || added.length > 0,
    publish() {
      for (const [id] of deleted) base.erase(id);
      for (const [id, row] of updates) base.replaceRow(id, row);
      for (const row of added) base.append(row);
      return original;
    },
  };
}
