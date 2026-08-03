/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pending-mutation overlay, in the shape the server's read surface needs to
 * read it. One reader for every tool: `model_diff` (#2000) and, since #2004, the
 * query backend, `model_info` and `count_entities`.
 *
 * A `model_id` on this server does not name a file — it names a session model,
 * and `entity_set_property` / `entity_set_attribute` / `entity_create` /
 * `entity_delete` queue their edits in a `MutablePropertyView` overlay that the
 * parsed `IfcDataStore` never sees (the store's buffer and index are immutable;
 * the overlay materialises at `export_ifc` / `model_save` time).
 *
 * Read straight from the store, a tool therefore answers about the file as it
 * was parsed. That is the wrong answer for the caller most likely to ask: an
 * agent edits, reads back to confirm, and is told its edit did not happen — and
 * the natural recovery from that is to edit again.
 *
 * **Reads fold the overlay in silently; the payload then says how many edits are
 * queued.** Folding is what makes "what is there now" answerable at all, and
 * `query_entities`' filters make it non-negotiable: a query for the value an
 * agent just wrote has to find it, and a tool that reported the divergence
 * instead of folding would still return the pre-edit row set. Reporting is what
 * keeps the answer honest about not being on disk yet — `pendingMutations` is
 * absent, not zero, on a session that has never been edited, so nothing changes
 * for a read-only caller.
 */

import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { MutablePropertyView, NewEntity } from '@ifc-lite/mutations';
import {
  getAttributeNamesAcrossSchemas,
  getInheritanceChainAcrossSchemas,
  type IfcDataStore,
} from '@ifc-lite/parser';
import type { LoadedModel } from './context.js';

/** An entity that exists only in the overlay (`entity_create`). */
export interface CreatedEntity {
  expressId: number;
  /** IFC class as authored, e.g. `IfcWall`. */
  ifcType: string;
  /** Empty for a created entity that carries none — an `IfcCartesianPoint`, or
   *  a root the caller left unidentified. Never empty in {@link
   *  PendingOverlay.created}, which is the cross-model-identity list. */
  globalId: string;
  name?: string;
  description?: string;
  /** The positional STEP attributes exactly as authored. */
  attributes: readonly unknown[];
}

/**
 * Attribute writes queued for an entity, keyed by IFC attribute name.
 *
 * **Not a fixed set of fields, deliberately.** This used to project the three
 * names the fingerprint hashes (`Name` / `Description` / `ObjectType`) while
 * `entity_set_attribute` accepted four, so a written `Tag` was queued and never
 * read back (#2014). A projection that enumerates has to be kept in step with
 * the write tool's enum by hand, and was not. Passing every queued write through
 * means the read surface cannot fall behind the write surface again: whatever
 * the enum grows, the readback carries.
 */
export type AttributeOverrides = ReadonlyMap<string, string>;

/**
 * One queued `IfcRel…` record, resolved to the entities it links.
 *
 * `entity_create` is the only way an agent can relate anything over MCP, so a
 * queued relationship is how a session says "this new wall is in that storey".
 * Reading it back is what keeps `in_storey` from dropping an entity the same
 * session just placed.
 */
export interface QueuedRelation {
  /** expressId of the queued `IfcRel…` record itself. */
  relationshipId: number;
  /** The `Relating…` end — the container, whole, or type. */
  relating: number;
  /** The `Related…` end(s) — the contents, parts, or occurrences. */
  related: readonly number[];
}

/** The overlay's read surface, as every folding tool consumes it. */
export interface PendingOverlay {
  /** Express ids tombstoned by `entity_delete`. Empty is the common case. */
  readonly deleted: ReadonlySet<number>;
  /** Entities queued by `entity_create` that carry a GlobalId, in creation
   *  order. The identity list: `model_diff` compares on it, and
   *  `get_entity(global_id)` resolves against it. A created entity without one
   *  is reachable through {@link createdEntity} by expressId. */
  readonly created: readonly CreatedEntity[];
  /** Every queued entity, GlobalId-bearing or not, in creation order. What a
   *  *count* is about: a created `IfcCartesianPoint` has no identity to compare
   *  but is still one more entity in the model. `entity_delete` on a queued
   *  entity forgets it rather than tombstoning it, so this list and `deleted`
   *  never overlap. */
  readonly createdAll: readonly CreatedEntity[];
  /** Queued mutations on this model — the same number `mutation_diff` reports.
   *  Echoed back so a caller can tell an answer that includes uncommitted edits
   *  from one taken over the file as parsed. */
  readonly pendingMutations: number;
  /** Any queued entity by expressId, GlobalId-bearing or not. Null when the id
   *  is not one this session created. */
  createdEntity(expressId: number): CreatedEntity | null;
  attributes(expressId: number): AttributeOverrides;
  /** Every entity with a queued attribute write, keyed by expressId. For loops
   *  over a whole model: `attributes(id)` builds a map per call, which is fine
   *  for one entity and not for a million. */
  attributesByEntity(): ReadonlyMap<number, AttributeOverrides>;
  /** Base property sets with the overlay's edits applied. */
  propertySets(expressId: number): PropertySet[];
  /** Base quantity sets with the overlay's edits applied. */
  quantitySets(expressId: number): QuantitySet[];
  /** Queued relationships of one IFC class, e.g.
   *  `'IfcRelContainedInSpatialStructure'`. Empty for a session that created
   *  none, which is the common case. */
  queuedRelations(ifcRelType: string): readonly QueuedRelation[];
}

/**
 * The model's pending overlay, or `null` when it has none.
 *
 * Null is the answer for every model that was only ever read: the backend
 * creates the view lazily on the first mutation, so an unedited session pays
 * nothing and every caller keeps its original store-only path.
 */
export function pendingOverlay(model: LoadedModel): PendingOverlay | null {
  return model.backend.pendingOverlay();
}

/**
 * The same reader, built from the view directly.
 *
 * The backend owns its `MutablePropertyView` and folds the overlay into its own
 * query adapter, so it cannot go through `pendingOverlay` — that would need a
 * `LoadedModel`, which is the registry entry wrapped *around* the backend.
 */
export function overlayFromView(view: MutablePropertyView | null): PendingOverlay | null {
  if (!view || !view.hasPendingChanges()) return null;
  return new ViewOverlay(view);
}

/**
 * **Everything derived is lazy, and the point lookup does not derive at all.**
 *
 * A fresh `ViewOverlay` is built on every overlay read — that is what keeps it
 * honest, because there is no revision counter on `MutablePropertyView` to cache
 * against and `getMutations().length` is not one (`mutation_undo` splices the
 * history, so a later write can land back on the same length). A stale overlay
 * after a mutation is a correctness bug; rebuilding is not.
 *
 * So the rebuild is made cheap instead. The constructor does no work, each
 * derived collection is computed once per instance on first use, and
 * `createdEntity` — the one called per entity by `entityData` — goes straight to
 * the view's own id map rather than materialising the whole created list.
 * Measured on a 20k-wall model with 2,000 queued creates, a 1,000-id
 * `get_entities_bulk` went from ~1,960ms to ~7ms (median of five), and
 * `getMutations()` (which copies the whole history) is no longer touched unless
 * a payload reports the count.
 */
class ViewOverlay implements PendingOverlay {
  private readonly view: MutablePropertyView;
  private tombstones: ReadonlySet<number> | null = null;
  private all: readonly CreatedEntity[] | null = null;
  private identified: readonly CreatedEntity[] | null = null;
  private count: number | null = null;
  /** Built on first use and never for a session that asks no relationship
   *  question, which is most of them. */
  private relationsByType: Map<string, QueuedRelation[]> | null = null;

  constructor(view: MutablePropertyView) {
    this.view = view;
  }

  get deleted(): ReadonlySet<number> {
    if (!this.tombstones) this.tombstones = this.view.getTombstones();
    return this.tombstones;
  }

  get createdAll(): readonly CreatedEntity[] {
    if (!this.all) this.all = this.view.getNewEntities().map(toCreatedEntity);
    return this.all;
  }

  get created(): readonly CreatedEntity[] {
    if (!this.identified) this.identified = this.createdAll.filter((entity) => entity.globalId !== '');
    return this.identified;
  }

  get pendingMutations(): number {
    // `getMutations()` copies the whole history, so it is paid once per overlay
    // and only when something actually reports the number.
    if (this.count === null) this.count = this.view.getMutations().length;
    return this.count;
  }

  createdEntity(expressId: number): CreatedEntity | null {
    // The view already indexes new entities by id; going through `createdAll`
    // here made every `entityData` call O(number of queued creates).
    const raw = this.view.getNewEntity(expressId);
    return raw ? toCreatedEntity(raw) : null;
  }

  attributes(expressId: number): AttributeOverrides {
    // Every queued write, not a chosen few. Last write wins, which is what
    // `getAttributeMutationsForEntity` already orders for us.
    const out = new Map<string, string>();
    for (const { name, value } of this.view.getAttributeMutationsForEntity(expressId)) {
      out.set(name, value);
    }
    return out;
  }

  attributesByEntity(): ReadonlyMap<number, AttributeOverrides> {
    return this.view.getAttributeMutationsByEntity();
  }

  queuedRelations(ifcRelType: string): readonly QueuedRelation[] {
    if (!this.relationsByType) this.relationsByType = indexQueuedRelations(this.createdAll);
    return this.relationsByType.get(ifcRelType.toUpperCase()) ?? [];
  }

  propertySets(expressId: number): PropertySet[] {
    return this.view.getForEntity(expressId);
  }

  quantitySets(expressId: number): QuantitySet[] {
    return this.view.getQuantitiesForEntity(expressId);
  }
}

/**
 * Group queued `IfcRel…` creates by class, resolved to their two ends.
 *
 * **By attribute name, never by slot.** The two role attributes do sit at slots
 * 4 and 5 for every relationship in the schema, but which of them is the
 * `Relating` end is per-class: `IfcRelAggregates` puts `RelatingObject` at 4,
 * while `IfcRelContainedInSpatialStructure` puts `RelatedElements` there. That
 * is the same hazard as slot 4 being `ObjectType` on an `IfcObject` and
 * `ApplicableOccurrence` on an `IfcTypeObject`, and the same answer:
 * `getAttributeNamesAcrossSchemas` — cross-schema, so a queued IFC2X3 or IFC4X3
 * relationship resolves too (#2003).
 *
 * A relationship whose ends cannot be resolved is skipped rather than guessed —
 * which is also what happens to an IFC2X3 `IfcRelCoversSpaces`, whose slot 4 is
 * `RelatedSpace` where IFC4 has `RelatingSpace`: it has no `Relating…` end under
 * the IFC4 spelling, so it is skipped rather than wired backwards. It is never
 * looked up either, because `queuedRelations` is only ever asked for the five
 * classes in `REL_TYPE_MAP`, and those five carry identical role slots in all
 * three bundled schemas.
 */
function indexQueuedRelations(created: readonly CreatedEntity[]): Map<string, QueuedRelation[]> {
  const byType = new Map<string, QueuedRelation[]>();
  for (const entity of created) {
    const upper = entity.ifcType.toUpperCase();
    if (!upper.startsWith('IFCREL')) continue;
    const names = getAttributeNamesAcrossSchemas(entity.ifcType);
    if (names.length === 0) continue;
    let relating: number | undefined;
    let related: number[] | undefined;
    for (let i = 0; i < names.length; i++) {
      // The two prefixes are disjoint — `'Relating'.startsWith('Related')` is
      // false and so is the reverse — so the order of these two tests carries no
      // meaning. An earlier comment here claimed it did.
      if (names[i].startsWith('Related')) related ??= refIds(entity.attributes[i]);
      else if (names[i].startsWith('Relating')) relating ??= refIds(entity.attributes[i])[0];
    }
    if (relating === undefined || related === undefined || related.length === 0) continue;
    const list = byType.get(upper);
    const relation: QueuedRelation = { relationshipId: entity.expressId, relating, related };
    if (list) list.push(relation);
    else byType.set(upper, [relation]);
  }
  return byType;
}

/** Express ids from an authored `'#42'` reference or a list of them. */
function refIds(value: unknown): number[] {
  if (typeof value === 'string') {
    const id = Number.parseInt(value.trim().slice(1), 10);
    return value.trim().startsWith('#') && Number.isFinite(id) ? [id] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => refIds(item));
  return [];
}

/**
 * Entity count per STEP type key, with the session's queued creates and deletes
 * applied. Created entities are counted under the uppercase key the store uses,
 * so `entity_create('IfcWall')` lands on the same row as the walls already in
 * the file rather than opening a second `IfcWall` row.
 */
export function foldedTypeCounts(store: IfcDataStore, overlay: PendingOverlay | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [type, ids] of store.entityIndex.byType) {
    let live = ids.length;
    // Only walk the ids when something is actually tombstoned — the type pass is
    // otherwise O(number of types), and a model has millions of entities.
    if (overlay && overlay.deleted.size > 0) {
      for (const id of ids) if (overlay.deleted.has(id)) live--;
    }
    counts.set(type, live);
  }
  for (const entity of overlay?.createdAll ?? []) {
    const key = entity.ifcType.toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The model's entity count with the session's creates and deletes applied.
 *
 * Adjusts the parser's own total rather than re-summing `byType`, so an unedited
 * model's number is byte-for-byte what it always was. Tombstones only ever name
 * store entities — deleting a queued entity forgets it instead of tombstoning it
 * — so the two terms cannot double-count.
 */
export function foldedEntityCount(store: IfcDataStore, overlay: PendingOverlay | null): number {
  if (!overlay) return store.entityCount;
  return store.entityCount + overlay.createdAll.length - overlay.deleted.size;
}

/**
 * `{ pendingMutations: n }` when any of the sessions has queued edits, `{}`
 * otherwise — spread into a tool payload so an unedited session's shape is
 * untouched.
 *
 * Always a scalar, at every level of every payload. `model_diff` used to publish
 * a `{ base, head }` object under the same name inside `contentDiff`, so one
 * field name meant two shapes depending on where a caller found it; the split is
 * now `pendingMutationsBySide`.
 */
export function pendingMutationsField(...overlays: Array<PendingOverlay | null>): Record<string, number> {
  if (overlays.every((overlay) => overlay === null)) return {};
  return { pendingMutations: overlays.reduce((total, overlay) => total + (overlay?.pendingMutations ?? 0), 0) };
}

/**
 * Read the IfcRoot header of an overlay-created entity.
 *
 * `NewEntity.attributes` is the positional STEP list the caller authored, so
 * slots 0/2/3 are `GlobalId`/`Name`/`Description` **for an `IfcRoot` subtype**
 * in every schema version — that part of the layout is fixed. Nothing further
 * along is: slot 4 is `ObjectType` on an `IfcObject` but `ApplicableOccurrence`
 * on an `IfcTypeObject`, so `objectType` and `PredefinedType` are read from the
 * store for store entities and simply absent for created ones.
 *
 * **The `IfcRoot` half of that sentence is a precondition, not a description**,
 * and `entity_create` accepts any IFC class. Slot 0 of an
 * `IfcPropertySingleValue` is its `Name`, so reading it positionally turned
 * `entity_create('IfcPropertySingleValue', ["'Width'", …])` into an entity whose
 * GlobalId was `Width` — which then joined the cross-model identity list, so
 * `get_entity(global_id: 'Width')` resolved to a property value, `model_diff`
 * reported `Width` as an added entity, and `get_entities_bulk` could call it an
 * ambiguous GlobalId. This is the same hazard `indexQueuedRelations` avoids by
 * resolving relationship ends by attribute name, and the same one the columnar
 * parser hits when it keys an `IfcMaterial` on the Name in slot 0.
 *
 * So the header is read only when the class actually derives from `IfcRoot`,
 * cross-schema (#2003) so an IFC2X3- or IFC4X3-only root is not judged by the
 * IFC4 pin. A class no bundled schema declares has no chain to prove it is a
 * root, so it keeps an empty header — the same deliberate vendor gap
 * `diff-scope.ts` documents, and the safe direction: an unidentified entity is
 * merely unreachable by GlobalId, whereas a wrongly identified one corrupts the
 * identity space every other tool shares.
 *
 * `globalId` also comes back empty when slot 0 holds none — a created
 * `IfcCartesianPoint` has no cross-model identity, and neither has a created
 * root the caller left unidentified. Those are excluded from `created` (nothing
 * can compare or look them up by key) but stay reachable by expressId, because
 * `get_entity(express_id)` on an id this session just handed out must not answer
 * "not found", and they are still counted.
 */
function toCreatedEntity(entity: NewEntity): CreatedEntity {
  const rooted = getInheritanceChainAcrossSchemas(entity.type).includes('IfcRoot');
  return {
    expressId: entity.expressId,
    ifcType: entity.type,
    globalId: (rooted ? stepText(entity.attributes[0]) : undefined) ?? '',
    name: rooted ? stepText(entity.attributes[2]) : undefined,
    description: rooted ? stepText(entity.attributes[3]) : undefined,
    attributes: entity.attributes,
  };
}

/**
 * Unwrap one authored STEP attribute to plain text.
 *
 * `StoreEditor.addEntity` documents both `"'literal'"` and a bare string as
 * ways to write a string attribute, so the quotes have to come off before the
 * value is hashed — otherwise a created entity could never content-match the
 * same entity read back out of a file. `$` (unset), `*` (derived) and `#42`
 * (a reference) are not text.
 */
export function stepText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '$' || trimmed === '*' || trimmed.startsWith('#')) return undefined;
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'") || undefined;
  }
  return trimmed;
}
