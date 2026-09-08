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

import { getAttributeNamesAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
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
   * The same references as {@link refsOf}, GROUPED by authored attribute
   * instead of flattened — a SET/LIST-valued attribute (`RelatedObjects`, …)
   * as a nested array of ids, a single-valued attribute (`RelatingType`, …)
   * as a bare id. `refsOf`'s flat list cannot tell those apart, and the
   * closure walk needs to: it decides whether an overlay-created `IFCREL*`
   * may bridge into what it references using the exact same list-vs-bare
   * distinction `filterHiddenRefsFromRelationshipLine` makes for a
   * source-backed relationship's OUTPUT line (see
   * `relationshipRefsSurviveExclusion` in `reference-collector.ts`) — without
   * this, the authored path could only ask "is EVERY id excluded", which
   * wrongly permits bridging when a relationship's sole SUBJECT is hidden but
   * its unrelated TARGET (a pset id, never itself excludable) survives (#2548).
   * Optional: undefined for the id, or when the caller has no overlay.
   *
   * `sourceGroups` is the SAME grouped shape, already parsed from a
   * SOURCE-backed entity's raw STEP line by the caller (`reference-collector.ts`
   * has no other way to get one — this class has no bytes to read). When `id`
   * is source-backed (not overlay-created) and carries a queued positional or
   * named-attribute mutation, this splices that mutation's EFFECTIVE value in
   * at the right group before returning — otherwise the caller's raw-text
   * parse is stale where an edit retargeted a reference the source bytes
   * never show (#2637 follow-up). Ignored (and safe to omit) for an
   * overlay-created id, which always has its own authored payload to start
   * from instead.
   */
  refGroupsOf?(
    id: number,
    sourceGroups?: ReadonlyArray<number | readonly number[] | undefined>,
  ): ReadonlyArray<number | readonly number[]> | undefined;
  /**
   * Cheap existence check — no decode, no parse — for "does this SOURCE-backed
   * id carry ANY queued positional or named-attribute mutation at all". False
   * for an overlay-created id (its refs come from {@link refsOf} instead) and
   * for a tombstoned one.
   *
   * `collectReferencedEntityIds` in `reference-collector.ts` only pays for
   * decoding a SOURCE-backed entity's STEP line and re-deriving mutation-aware
   * groups (via {@link refGroupsOf}) on the `IFCREL*` bridge path, because
   * that path already needs the parse for its own bridge decision regardless
   * of whether a mutation exists. An ordinary PRODUCT never takes that path,
   * so a plain `setPositionalAttribute`/`setAttribute` retargeting one of its
   * references onto an id the source bytes never named was invisible to the
   * closure — the byte scan of the original bytes has no way to see it — while
   * emission (which does apply the mutation) still wrote the new id into the
   * output line: a dangling ref with no `visibleOnly` involved (#2637
   * follow-up, round 6: found via a retype-out-of-`IFCREL*` fused with a
   * same-record retarget, but reproduces identically with NO retype at all —
   * it is a general gap in the closure, not a retype-specific one). This
   * method exists so the walk can gate the SAME per-entity decode/parse cost
   * behind a cheap map lookup for every OTHER entity type too, instead of
   * paying it unconditionally for every source-backed entity in the file.
   */
  hasSourceMutation?(id: number): boolean;
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
 *
 * "Fast path" means `byType`/`size`/`get`/`has` stay pointer-identical to the
 * source view's own — no id's existence or class can differ when nothing
 * structural is queued, so there is nothing there for a wrapper to change.
 * `refGroupsOf` is a different question: a source-backed `IFCREL*`'s
 * reference can absolutely differ from its raw bytes when the ONLY thing
 * queued is a positional/named-attribute edit retargeting it — the exact
 * case with no create, delete or retype to trigger the `OverlayIndex` branch
 * below. `sourceOnly` still answers that one from `view` when a view is
 * available, so a `visibleOnly` closure walk sees it even on this fast path
 * (#2637 follow-up: CodeRabbit found the closure could keep judging such an
 * id by its stale, pre-edit reference).
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
    return sourceOnly(base, dataStore.entityIndex.byType, view);
  }
  return new OverlayIndex(base, dataStore.entityIndex.byType, view!, created, tombstones, retypes);
}

const EMPTY_IDS: ReadonlySet<number> = new Set<number>();
const EMPTY_RETYPES: ReadonlyMap<number, { newType: string }> = new Map();

/** Shared by {@link sourceOnly} and {@link OverlayIndex}'s `hasSourceMutation` —
 *  see that method's doc on `EffectiveEntityIndex` for why this needs to stay
 *  a cheap map-lookup-only check with no decode or parse. */
function hasQueuedSourceMutation(view: MutablePropertyView, id: number): boolean {
  const positional = typeof view.getPositionalMutationsForEntity === 'function'
    ? view.getPositionalMutationsForEntity(id)
    : null;
  if (positional && positional.size > 0) return true;
  const attributeMutations = typeof view.getAttributeMutationsForEntity === 'function'
    ? view.getAttributeMutationsForEntity(id)
    : [];
  return attributeMutations.length > 0;
}

/** The no-overlay answer: the source view, with the extra questions answered
 *  the only way the buffer can answer them.
 *
 *  `view` is still threaded through (not discarded, despite there being no
 *  create/delete/retype to react to) purely so `refGroupsOf` can resolve a
 *  source-backed id's positional/named-attribute mutations — see this
 *  function's own doc for why that is a real, reachable gap otherwise. */
function sourceOnly(
  base: CompleteEntityIndex,
  byType: Map<string, number[]>,
  view: MutablePropertyView | null,
): EffectiveEntityIndex {
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
    refGroupsOf: view
      ? (id, sourceGroups) => sourceBackedRefGroups(view, base, EMPTY_RETYPES, id, sourceGroups)
      : undefined,
    hasSourceMutation: view ? (id) => hasQueuedSourceMutation(view, id) : undefined,
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

  /**
   * See the interface doc: unlike {@link refsOf} (a deliberate UNION — see its
   * own doc for why over-inclusion is harmless there), this is the EFFECTIVE
   * groups: an override REPLACES its slot's group rather than adding a second
   * one alongside it. `refsOf`'s union is safe only for a consumer that treats
   * extra ids as harmless closure growth; `relationshipRefsSurviveExclusion`
   * is a BLOCKING predicate, so a stale, since-superseded group (e.g. a
   * `RelatedObjects` list retargeted away from a hidden entity by a later
   * `setPositionalAttribute`) must not still be able to veto bridging on the
   * value it was overridden away from.
   *
   * Resolved per authored attribute SLOT, same precedence
   * {@link effectiveAttributeRef} uses for one named attribute: a
   * `getAttributeMutationsForEntity` override (most specific — names the slot
   * by schema attribute name) wins, else a `getPositionalMutationsForEntity`
   * override at that index, else the creation payload's own value at that
   * index. Not cached: only called for `IFCREL*` entities, and only when a
   * `visibleOnly`/deletion filter is active, so the extra pass is rare.
   */
  refGroupsOf(
    id: number,
    sourceGroups?: ReadonlyArray<number | readonly number[] | undefined>,
  ): ReadonlyArray<number | readonly number[]> | undefined {
    const entity = this.created.get(id);
    if (entity) {
      if (this.tombstones.has(id)) return undefined;

      const effective: Array<IfcAttributeValue | string | undefined> = entity.attributes.slice();

      if (typeof this.view.getPositionalMutationsForEntity === 'function') {
        const positional = this.view.getPositionalMutationsForEntity(id);
        if (positional) for (const [index, value] of positional) effective[index] = value;
      }

      if (typeof this.view.getAttributeMutationsForEntity === 'function') {
        const effectiveType = this.retypes.get(id)?.newType ?? entity.type;
        // Cross-schema, not the IFC4 pin — see `applyAttributeMutations` in
        // `step-exporter.ts` for why: an IFC4X3-only class resolves no slots
        // under the pin, so a named override on one was silently ignored
        // here while emission (which already uses this resolver) applied it,
        // leaving `refGroupsOf` answering from the STALE, pre-override value
        // (#2637 follow-up).
        const names = getAttributeNamesAcrossSchemas(effectiveType);
        for (const { name, value } of this.view.getAttributeMutationsForEntity(id)) {
          const index = names.indexOf(name);
          if (index >= 0) effective[index] = value;
        }
      }

      return groupsFromAttributeValues(effective);
    }

    // Source-backed: this class has no parsed attribute list of its own —
    // delegate to the shared resolver both this branch and `sourceOnly`'s
    // wiring use, since a source-backed id's mutations answer identically
    // either way (structural overlay activity elsewhere in the model has no
    // bearing on THIS id's own positional/attribute edits).
    if (this.tombstones.has(id)) return undefined;
    return sourceBackedRefGroups(this.view, this.base, this.retypes, id, sourceGroups);
  }

  hasSourceMutation(id: number): boolean {
    // Overlay-created ids answer through `refsOf` instead — see that method's
    // own doc for why its UNION is the right answer there. A tombstoned id
    // has no line to walk into regardless of what it once carried.
    if (this.created.has(id) || this.tombstones.has(id)) return false;
    return hasQueuedSourceMutation(this.view, id);
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
    // creation payload) still answers correctly. Cross-schema resolver — see
    // the identical note in `refGroupsOf` above.
    const effectiveType = this.retypes.get(id)?.newType ?? entity.type;
    const index = getAttributeNamesAcrossSchemas(effectiveType).indexOf(attrName);
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

/** One authored attribute's contribution to `refGroupsOf`'s grouped shape: a
 *  bare id for a single-valued attribute, an array (even an empty one, once
 *  it's known to be list-valued) for a SET/LIST, or `undefined` when the
 *  value carries no reference at all — matching `relationshipRefsSurviveExclusion`'s
 *  own "no group == does not participate" reading. */
function groupFromAttributeValue(value: IfcAttributeValue | string | undefined): number | readonly number[] | undefined {
  const ids = authoredEntityRefs(value);
  if (ids.length === 0) return undefined;
  return Array.isArray(value) || ids.length > 1 ? ids : ids[0];
}

/** {@link groupFromAttributeValue}, applied over a whole authored attribute
 *  list — the shared tail of `refGroupsOf`'s overlay-created branch. */
function groupsFromAttributeValues(
  values: ReadonlyArray<IfcAttributeValue | string | undefined>,
): Array<number | readonly number[]> {
  const groups: Array<number | readonly number[]> = [];
  for (const value of values) {
    const group = groupFromAttributeValue(value);
    if (group !== undefined) groups.push(group);
  }
  return groups;
}

/**
 * `refGroupsOf` for a SOURCE-backed id (one with no `NewEntity` creation
 * payload) — shared by `OverlayIndex.refGroupsOf`'s source-backed branch and
 * `sourceOnly`'s wiring, since neither has a parsed attribute list of its
 * own to start from: `sourceGroups`, already parsed from the raw STEP line
 * by the caller (`reference-collector.ts`), is the only starting point
 * either has. Splices in a queued positional or named-attribute mutation at
 * the position it names, same precedence as the overlay-created branch: a
 * `getAttributeMutationsForEntity` override (resolved to a slot via
 * {@link getAttributeNamesAcrossSchemas}, cross-schema for the identical
 * reason `applyAttributeMutations` in `step-attribute-mutations.ts` is) wins, else a
 * `getPositionalMutationsForEntity` override at that index, else the raw
 * text's own group stands.
 *
 * Returns undefined — not `sourceGroups` verbatim — when `id` has no
 * mutation at all (the overwhelmingly common case for an `IFCREL*` entity),
 * so a caller with no override to apply keeps using its own
 * already-computed answer instead of paying for a copy that changes nothing.
 */
function sourceBackedRefGroups(
  view: MutablePropertyView,
  base: CompleteEntityIndex,
  retypes: ReadonlyMap<number, { newType: string }>,
  id: number,
  sourceGroups: ReadonlyArray<number | readonly number[] | undefined> | undefined,
): ReadonlyArray<number | readonly number[]> | undefined {
  if (!sourceGroups) return undefined;
  const positional = typeof view.getPositionalMutationsForEntity === 'function'
    ? view.getPositionalMutationsForEntity(id)
    : null;
  const attributeMutations = typeof view.getAttributeMutationsForEntity === 'function'
    ? view.getAttributeMutationsForEntity(id)
    : [];
  if ((!positional || positional.size === 0) && attributeMutations.length === 0) return undefined;

  const record = base.get(id);
  const effective: Array<number | readonly number[] | undefined> = sourceGroups.slice();
  if (positional) {
    for (const [index, value] of positional) effective[index] = groupFromAttributeValue(value);
  }
  if (attributeMutations.length > 0 && record) {
    const effectiveType = retypes.get(id)?.newType ?? record.type;
    const names = getAttributeNamesAcrossSchemas(effectiveType);
    for (const { name, value } of attributeMutations) {
      const index = names.indexOf(name);
      if (index >= 0) effective[index] = groupFromAttributeValue(value);
    }
  }
  const out: Array<number | readonly number[]> = [];
  for (const group of effective) if (group !== undefined) out.push(group);
  return out;
}
