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
  getInheritanceChainAcrossSchemas,
  effectiveRelationshipEdges,
  resolveEffectiveEntityRecord,
  resolveEffectiveRelationshipOverlay,
  type EffectiveRelationshipOverlay,
  type IfcDataStore,
  normalizeIfcTypeName,
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
/** The overlay's read surface, as every folding tool consumes it. */
export interface PendingOverlay {
  /** Express ids tombstoned by `entity_delete`. Empty is the common case.
   *  Since #2012 this includes an entity the session created and then deleted:
   *  `deleteEntity` tombstones it as well as forgetting it, so that "was this
   *  deleted" has a true answer to find. A count therefore has to intersect
   *  this with the store rather than subtracting its size — see
   *  {@link foldedEntityCount}. */
  readonly deleted: ReadonlySet<number>;
  /** Entities queued by `entity_create` that carry a GlobalId, in creation
   *  order. The identity list: `model_diff` compares on it, and
   *  `get_entity(global_id)` resolves against it. A created entity without one
   *  is reachable through {@link createdEntity} by expressId. */
  readonly created: readonly CreatedEntity[];
  /** Every queued entity, GlobalId-bearing or not, in creation order. What a
   *  *count* is about: a created `IfcCartesianPoint` has no identity to compare
   *  but is still one more entity in the model. `entity_delete` on a queued
   *  entity drops it from this list, so a created-then-deleted entity appears
   *  here not at all and in {@link deleted} once. */
  readonly createdAll: readonly CreatedEntity[];
  /** Queued mutations on this model — the same number `mutation_diff` reports.
   *  Echoed back so a caller can tell an answer that includes uncommitted edits
   *  from one taken over the file as parsed. */
  readonly pendingMutations: number;
  /** Any queued entity by expressId, GlobalId-bearing or not. Null when the id
   *  is not one this session created. */
  createdEntity(expressId: number): CreatedEntity | null;
  /** The class a queued `setEntityType` gives the entity (`IfcWall` spelling),
   *  or null when it keeps its authored class. Every read that names an
   *  entity's type must go through this, or it disagrees with what export
   *  writes (#5009 review). */
  effectiveType(expressId: number): string | null;
  attributes(expressId: number): AttributeOverrides;
  positionalAttributes(expressId: number): ReadonlyMap<number, unknown>;
  /** Every entity with a queued attribute write, keyed by expressId. For loops
   *  over a whole model: `attributes(id)` builds a map per call, which is fine
   *  for one entity and not for a million. */
  attributesByEntity(): ReadonlyMap<number, AttributeOverrides>;
  /** Base property sets with the overlay's edits applied. */
  propertySets(expressId: number): PropertySet[];
  /** Base quantity sets with the overlay's edits applied. */
  quantitySets(expressId: number): QuantitySet[];
  relationshipEdges(expressId: number, ifcRelType?: string): ReturnType<typeof effectiveRelationshipEdges>;
  readonly supersededRelationshipIds: ReadonlySet<number>;
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
export function overlayFromView(view: MutablePropertyView | null, store: IfcDataStore): PendingOverlay | null {
  if (!view || !view.hasPendingChanges()) return null;
  return new ViewOverlay(view, store);
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
  private readonly store: IfcDataStore;
  private tombstones: ReadonlySet<number> | null = null;
  private all: readonly CreatedEntity[] | null = null;
  private identified: readonly CreatedEntity[] | null = null;
  private count: number | null = null;
  private effectiveRelations: EffectiveRelationshipOverlay | null = null;

  constructor(view: MutablePropertyView, store: IfcDataStore) {
    this.view = view;
    this.store = store;
  }

  get deleted(): ReadonlySet<number> {
    if (!this.tombstones) this.tombstones = this.view.getTombstones();
    return this.tombstones;
  }

  /** The created entity as export writes it: effective class, name-relaid attributes, edits applied. */
  private effectiveCreatedEntity(entity: NewEntity): CreatedEntity {
    const record = resolveEffectiveEntityRecord(entity, {
      retype: this.view.getEntityTypeMutation(entity.expressId)?.newType,
      named: this.view.getAttributeMutationsForEntity(entity.expressId).map(({ name, value }) => [name, value] as const),
      positional: this.view.getPositionalMutationsForEntity(entity.expressId) ?? [],
    }, this.store.schemaVersion);
    return toCreatedEntity({ ...entity, type: record.type, attributes: record.attributes as NewEntity['attributes'] });
  }

  get createdAll(): readonly CreatedEntity[] {
    if (!this.all) this.all = this.view.getNewEntities().map(entity => this.effectiveCreatedEntity(entity));
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
    return raw ? this.effectiveCreatedEntity(raw) : null;
  }

  effectiveType(expressId: number): string | null {
    const retype = this.view.getEntityTypeMutation(expressId)?.newType;
    return retype ? normalizeIfcTypeName(retype) : null;
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

  positionalAttributes(expressId: number): ReadonlyMap<number, unknown> {
    return this.view.getPositionalMutationsForEntity(expressId) ?? new Map();
  }

  attributesByEntity(): ReadonlyMap<number, AttributeOverrides> {
    return this.view.getAttributeMutationsByEntity();
  }

  private get relationshipOverlay(): EffectiveRelationshipOverlay {
    if (!this.effectiveRelations) this.effectiveRelations = resolveEffectiveRelationshipOverlay(this.store, {
      createdEntities: () => this.view.getNewEntities(),
      mutatedEntityIds: () => this.view.getMutations().map(mutation => mutation.entityId),
      namedAttributes: id => this.view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value] as const),
      positionalAttributes: id => this.view.getPositionalMutationsForEntity(id) ?? [],
      entityType: id => this.view.getEntityTypeMutation(id)?.newType,
      isDeleted: id => this.view.isDeleted(id),
    });
    return this.effectiveRelations;
  }

  relationshipEdges(expressId: number, ifcRelType?: string): ReturnType<typeof effectiveRelationshipEdges> {
    return effectiveRelationshipEdges(this.relationshipOverlay, id => this.view.isDeleted(id), expressId, ifcRelType);
  }

  get supersededRelationshipIds(): ReadonlySet<number> {
    return this.relationshipOverlay.supersededSourceIds;
  }

  propertySets(expressId: number): PropertySet[] {
    return this.view.getForEntity(expressId);
  }

  quantitySets(expressId: number): QuantitySet[] {
    return this.view.getQuantitiesForEntity(expressId);
  }
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
 * model's number is byte-for-byte what it always was.
 *
 * Only tombstones that name a STORE entity are subtracted. A created-then-
 * deleted entity is already absent from `createdAll`, so counting its tombstone
 * too would subtract it a second time and report one entity fewer than the file
 * has (#2012). This also makes a tombstone on an id the store never had — which
 * `entity_delete` rejects, but nothing here relies on that — unable to drive the
 * count below the truth.
 */
export function foldedEntityCount(store: IfcDataStore, overlay: PendingOverlay | null): number {
  if (!overlay) return store.entityCount;
  let deletedFromStore = 0;
  for (const id of overlay.deleted) {
    if (store.entityIndex.byId.has(id) || store.deferredEntityIndex?.has(id)) deletedFromStore++;
  }
  return store.entityCount + overlay.createdAll.length - deletedFromStore;
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
 * ambiguous GlobalId. The columnar parser hits the same hazard when it keys an
 * `IfcMaterial` on the Name in slot 0.
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
