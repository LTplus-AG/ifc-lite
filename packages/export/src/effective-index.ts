/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The effective model: what the file WILL say, not what it said when parsed.
 *
 * `IfcDataStore` answers for the source buffer. The `MutablePropertyView`
 * overlay knows what the session has since created, retyped and deleted, and
 * never writes back into the store (its buffer and `CompactEntityIndex` are
 * immutable by construction — see `StoreEditor`). So every export pass that
 * asked `dataStore` a question the overlay owns produced a saved file that
 * disagreed with what the user did (#2012):
 *
 *   - a `visibleOnly` closure computed from `entityIndex.byId` can never make an
 *     overlay-created entity a root, nor walk into one, so a created wall was
 *     silently absent from the export;
 *   - `endsWith('TYPE')` on the source record's class misses an overlay-created
 *     `IfcWallType`, so its psets were emitted as occurrence relations;
 *   - and a tombstoned entity still looked alive to the pset/quantity passes.
 *
 * This module is the one place those questions are answered. Every consumer
 * takes the index rather than reaching for `dataStore`, so a new pass cannot
 * reintroduce the defect by forgetting to ask the overlay: there is nothing
 * else to ask.
 *
 * Three distinctions the shape deliberately keeps:
 *
 *   - {@link EffectiveEntityIndex.get} answers *as authored or parsed* — the
 *     source record's class and byte range, or the creation payload's class.
 *     {@link EffectiveEntityIndex.typeOf} answers the *effective* class, with
 *     retypes applied and normalised to the UPPERCASE form the store uses.
 *     The source-iteration pass needs the former (it hands the original class
 *     to `retypeStepLine` as the from-type); every classification needs the
 *     latter.
 *   - a tombstoned id does not exist: `get` returns undefined, `has` is false,
 *     and iteration skips it. `isDeleted` is what distinguishes "deleted" from
 *     "never existed" for callers that must tell them apart.
 *   - an overlay-created record has no bytes, so its outgoing references are
 *     read from its authored attributes by {@link EffectiveEntityIndex.refsOf}
 *     instead of scanned out of the source buffer.
 */

import { getAllAttributesForEntity, type IfcDataStore } from '@ifc-lite/parser';
import {
  OVERLAY_BYTE_OFFSET,
  type IfcAttributeValue,
  type MutablePropertyView,
  type NewEntity,
} from '@ifc-lite/mutations';
import {
  getCompleteEntityIndex,
  type CompleteEntityIndex,
  type ExportEntityRef,
} from './entity-iteration.js';

/**
 * The complete source index (`byId` + any deferred property atoms) with the
 * overlay folded in. Extends {@link CompleteEntityIndex}, so anything that
 * already takes the source view takes this one.
 */
export interface EffectiveEntityIndex extends CompleteEntityIndex {
  /** Effective IFC class, UPPERCASE, retype applied. Undefined when the id does
   *  not exist in the effective model (unknown, or tombstoned). */
  typeOf(id: number): string | undefined;
  /**
   * The same answer for an id whose record you are already holding — on an
   * iteration path, where the extra `get` is not free.
   *
   * `CompactEntityIndex.get` binary-searches and allocates an `EntityRef` per
   * call, so re-deriving the class from the id while iterating would cost
   * O(E log E) plus one allocation per entity for a string the loop already has.
   */
  effectiveType(id: number, recordType: string): string;
  /** Created by the overlay this session (no source record). */
  isOverlayCreated(id: number): boolean;
  /** Tombstoned by the overlay this session. True for a source entity the
   *  session deleted AND for one it created and then deleted. */
  isDeleted(id: number): boolean;
  /** Outgoing `#id` references of an OVERLAY-created record, or undefined when
   *  the id has source bytes to scan instead. */
  refsOf(id: number): readonly number[] | undefined;
  /**
   * The effective `#id` value of ONE NAMED attribute of an OVERLAY-created
   * record, or undefined when the id was not created by this overlay, the
   * attribute carries no reference, or the record has since been tombstoned.
   *
   * `refsOf` cannot answer a positional question: it deliberately UNIONS the
   * creation payload with every queued override (see its own doc), so a
   * caller that needs a *specific* attribute — e.g. `IfcRelVoidsElement`'s
   * `RelatingBuildingElement` — cannot recover it positionally from that
   * union once the record has been edited after creation (#2347). This
   * resolves by name instead: an attribute-name mutation wins, else the
   * positional-mutation slot at that attribute's schema index, else the
   * creation-payload value at that index.
   */
  effectiveAttributeRef(id: number, attrName: string): number | undefined;
  /** Effective UPPERCASE-type → ids index: tombstones removed, retypes moved to
   *  their new class, overlay creations added. */
  readonly byType: Map<string, number[]>;
}

/**
 * Build the effective view over a store plus its overlay.
 *
 * Passing no view, or `applyMutations: false`, returns the source view
 * unchanged — the same object `getCompleteEntityIndex` would hand back, with no
 * per-entity wrapper and no extra allocation on the common export path. An
 * overlay that has queued nothing structural (no creates, no deletes, no
 * retypes) takes the same fast path: attribute and property edits do not change
 * which entities exist or what class they are.
 */
export function getEffectiveEntityIndex(
  dataStore: IfcDataStore,
  mutationView: MutablePropertyView | null | undefined,
  applyMutations: boolean,
): EffectiveEntityIndex {
  const base = getCompleteEntityIndex(dataStore);
  const view = applyMutations ? (mutationView ?? null) : null;

  const created = new Map<number, NewEntity>();
  if (view && typeof view.getNewEntities === 'function') {
    for (const entity of view.getNewEntities()) created.set(entity.expressId, entity);
  }
  const tombstones: ReadonlySet<number> =
    view && typeof view.getTombstones === 'function' ? view.getTombstones() : EMPTY_IDS;
  const retypes: ReadonlyMap<number, { newType: string }> =
    view && typeof view.getTypeMutations === 'function' ? view.getTypeMutations() : EMPTY_RETYPES;

  if (created.size === 0 && tombstones.size === 0 && retypes.size === 0) {
    return sourceOnly(base, dataStore.entityIndex.byType);
  }
  return new OverlayIndex(base, dataStore.entityIndex.byType, view!, created, tombstones, retypes);
}

const EMPTY_IDS: ReadonlySet<number> = new Set<number>();
const EMPTY_RETYPES: ReadonlyMap<number, { newType: string }> = new Map();

/** The no-overlay answer: the source view, with the extra questions answered
 *  the only way the buffer can answer them. */
function sourceOnly(base: CompleteEntityIndex, byType: Map<string, number[]>): EffectiveEntityIndex {
  return {
    get: (id) => base.get(id),
    has: (id) => base.has(id),
    get size() {
      return base.size;
    },
    [Symbol.iterator]: () => base[Symbol.iterator](),
    typeOf: (id) => base.get(id)?.type.toUpperCase(),
    effectiveType: (_id, recordType) => recordType.toUpperCase(),
    isOverlayCreated: () => false,
    isDeleted: () => false,
    refsOf: () => undefined,
    effectiveAttributeRef: () => undefined,
    byType,
  };
}

class OverlayIndex implements EffectiveEntityIndex {
  private readonly base: CompleteEntityIndex;
  private readonly sourceByType: Map<string, number[]>;
  private readonly view: MutablePropertyView;
  private readonly created: Map<number, NewEntity>;
  private readonly tombstones: ReadonlySet<number>;
  private readonly retypes: ReadonlyMap<number, { newType: string }>;
  private cachedByType: Map<string, number[]> | null = null;
  private readonly cachedRefs = new Map<number, readonly number[]>();

  constructor(
    base: CompleteEntityIndex,
    sourceByType: Map<string, number[]>,
    view: MutablePropertyView,
    created: Map<number, NewEntity>,
    tombstones: ReadonlySet<number>,
    retypes: ReadonlyMap<number, { newType: string }>,
  ) {
    this.base = base;
    this.sourceByType = sourceByType;
    this.view = view;
    this.created = created;
    this.tombstones = tombstones;
    this.retypes = retypes;
  }

  get(id: number): ExportEntityRef | undefined {
    if (this.tombstones.has(id)) return undefined;
    const overlay = this.created.get(id);
    if (overlay) {
      return { type: overlay.type, byteOffset: OVERLAY_BYTE_OFFSET, byteLength: 0 };
    }
    return this.base.get(id);
  }

  has(id: number): boolean {
    if (this.tombstones.has(id)) return false;
    return this.created.has(id) || this.base.has(id);
  }

  get size(): number {
    let live = 0;
    for (const id of this.tombstones) if (this.base.has(id)) live++;
    return this.base.size - live + this.created.size;
  }

  *[Symbol.iterator](): IterableIterator<[number, ExportEntityRef]> {
    for (const entry of this.base) {
      if (this.tombstones.has(entry[0])) continue;
      yield entry;
    }
    for (const [id, entity] of this.created) {
      yield [id, { type: entity.type, byteOffset: OVERLAY_BYTE_OFFSET, byteLength: 0 }];
    }
  }

  typeOf(id: number): string | undefined {
    const ref = this.get(id);
    if (!ref) return undefined;
    return this.effectiveType(id, ref.type);
  }

  effectiveType(id: number, recordType: string): string {
    return (this.retypes.get(id)?.newType ?? recordType).toUpperCase();
  }

  isOverlayCreated(id: number): boolean {
    return this.created.has(id);
  }

  isDeleted(id: number): boolean {
    return this.tombstones.has(id);
  }

  /**
   * A created record's outgoing references, read off the authored payload.
   *
   * The UNION of the creation payload and every queued override, not the
   * override applied on top of it. Over-inclusion keeps an entity in an export
   * closure that a later edit may have stopped pointing at — harmless, it is
   * one extra record. Under-inclusion drops one the file still references,
   * which is a broken file. The asymmetry decides it.
   */
  refsOf(id: number): readonly number[] | undefined {
    const entity = this.created.get(id);
    if (!entity || this.tombstones.has(id)) return undefined;
    const cached = this.cachedRefs.get(id);
    if (cached) return cached;
    const out: number[] = [];
    for (const value of entity.attributes) out.push(...authoredEntityRefs(value));
    if (typeof this.view.getPositionalMutationsForEntity === 'function') {
      const positional = this.view.getPositionalMutationsForEntity(id);
      if (positional) for (const value of positional.values()) out.push(...authoredEntityRefs(value));
    }
    if (typeof this.view.getAttributeMutationsForEntity === 'function') {
      for (const { value } of this.view.getAttributeMutationsForEntity(id)) {
        out.push(...authoredEntityRefs(value));
      }
    }
    this.cachedRefs.set(id, out);
    return out;
  }

  effectiveAttributeRef(id: number, attrName: string): number | undefined {
    const entity = this.created.get(id);
    if (!entity || this.tombstones.has(id)) return undefined;

    // An attribute-name mutation is the most recent, most specific override —
    // `setAttribute(id, 'RelatingBuildingElement', ...)` names exactly this
    // slot, so it wins regardless of where it landed positionally.
    if (typeof this.view.getAttributeMutationsForEntity === 'function') {
      for (const { name, value } of this.view.getAttributeMutationsForEntity(id)) {
        if (name === attrName) return authoredEntityRefs(value)[0];
      }
    }

    // No named override — fall back to the positional slot the schema says
    // this attribute lives at, so a positional mutation (or the untouched
    // creation payload) still answers correctly.
    const index = getAllAttributesForEntity(entity.type).findIndex((attr) => attr.name === attrName);
    if (index < 0) return undefined;

    if (typeof this.view.getPositionalMutationsForEntity === 'function') {
      const positional = this.view.getPositionalMutationsForEntity(id);
      const value = positional?.get(index);
      if (value !== undefined) return authoredEntityRefs(value)[0];
    }

    return authoredEntityRefs(entity.attributes[index])[0];
  }

  get byType(): Map<string, number[]> {
    if (this.cachedByType) return this.cachedByType;
    // Shallow copy: the arrays are SHARED with the store until a key actually
    // changes, and every key that changes is replaced with a fresh array. The
    // store's own index is never mutated.
    const out = new Map(this.sourceByType);

    const removeByType = new Map<string, Set<number>>();
    const markRemoved = (id: number): void => {
      const sourceType = this.base.get(id)?.type.toUpperCase();
      if (!sourceType) return;
      let bucket = removeByType.get(sourceType);
      if (!bucket) removeByType.set(sourceType, (bucket = new Set()));
      bucket.add(id);
    };
    for (const id of this.tombstones) markRemoved(id);
    for (const [id, retype] of this.retypes) {
      if (this.created.has(id)) continue;
      if (this.base.get(id)?.type.toUpperCase() !== retype.newType.toUpperCase()) markRemoved(id);
    }
    for (const [type, ids] of removeByType) {
      const arr = out.get(type);
      if (arr) out.set(type, arr.filter((id) => !ids.has(id)));
    }

    const append = (type: string, id: number): void => {
      const arr = out.get(type);
      out.set(type, arr ? [...arr, id] : [id]);
    };
    for (const id of this.created.keys()) {
      const type = this.typeOf(id);
      if (type) append(type, id);
    }
    for (const [id, retype] of this.retypes) {
      if (this.created.has(id) || this.tombstones.has(id) || !this.base.has(id)) continue;
      const target = retype.newType.toUpperCase();
      if (this.base.get(id)?.type.toUpperCase() !== target) append(target, id);
    }

    this.cachedByType = out;
    return out;
  }
}

/**
 * Every express id an AUTHORED attribute value references, recursing into lists.
 *
 * `'#42'` is the documented `StoreEditor.addEntity` form for a reference; a
 * value that merely contains one ('detail #999') is text, and a bare number is a
 * measure, not an id. That is the same distinction the byte scanner makes for
 * source records, and the reason this cannot be shared with the source path:
 * there a reference IS a number, because the parser already resolved it.
 */
export function authoredEntityRefs(value: IfcAttributeValue | string | undefined): number[] {
  if (Array.isArray(value)) return value.flatMap((item) => authoredEntityRefs(item));
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== '#') return [];
  const digits = trimmed.slice(1);
  const id = Number.parseInt(digits, 10);
  return Number.isInteger(id) && id > 0 && String(id) === digits ? [id] : [];
}
