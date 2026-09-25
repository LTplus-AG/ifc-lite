/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sameOverlayValue } from './overlay-value-equality.js';
import { NewEntityMap } from './new-entity-map.js';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { IfcAttributeValue, PropertyMutation, QuantityMutation, AttributeMutation,
  EntityTypeMutation, Mutation, SetOverlaySnapshot } from './types.js';


/**
 * Everything `deleteEntity` purges out of the live overlay maps for a
 * forgotten-created entity, captured so `restoreNewEntity` can put it all
 * back. See the field doc on `MutablePropertyView.forgottenEntityOverlay`.
 */
export interface ForgottenEntityOverlay {
  propertyEntries: Array<[key: string, mutation: PropertyMutation]>;
  quantityEntries: Array<[key: string, mutation: QuantityMutation]>;
  attributeEntries: Array<[key: string, mutation: AttributeMutation]>;
  positionalAttrs: Map<number, IfcAttributeValue> | null;
  typeMutation: EntityTypeMutation | null;
  newPsets: Map<string, PropertySet> | null;
  newQsets: Map<string, QuantitySet> | null;
  deletedPsetKeys: string[];
  deletedQsetKeys: string[];
  /** This entity's own records, removed from the append-only `mutationHistory`. */
  historyEntries: Mutation[];
}

/** Internal mutable overlay state; source tables and extractors are never copied. */
export class MutableOverlayState {
  protected propertyMutations: Map<string, PropertyMutation> = new Map();
  protected quantityMutations: Map<string, QuantityMutation> = new Map();
  /**
   * Secondary indices: entityId → mutation keys for that entity.
   *
   * `getForEntity` previously iterated the entire `propertyMutations` /
   * `quantityMutations` map per pset to find newly-added properties — O(M·P)
   * per call. These indices keep that step O(M_entity) instead.
   */
  protected propertyKeysByEntity: Map<number, Set<string>> = new Map();
  protected quantityKeysByEntity: Map<number, Set<string>> = new Map();
  protected attributeKeysByEntity: Map<number, Set<string>> = new Map();
  protected deletedPsets: Set<string> = new Set(); // `${entityId}:${psetName}`
  protected deletedQsets: Set<string> = new Set(); // `${entityId}:${qsetName}`
  protected newPsets: Map<number, Map<string, PropertySet>> = new Map(); // entityId -> psetName -> PropertySet
  protected newQsets: Map<number, Map<string, QuantitySet>> = new Map(); // entityId -> qsetName -> QuantitySet
  protected attributeMutations: Map<string, AttributeMutation> = new Map(); // `${entityId}:attr:${attrName}`
  protected positionalAttrMutations: Map<number, Map<number, IfcAttributeValue>> = new Map(); // entityId -> argIndex -> value
  protected typeMutations: Map<number, EntityTypeMutation> = new Map(); // entityId -> retype intent
  protected newEntities: NewEntityMap = new NewEntityMap();
  protected tombstones: Set<number> = new Set();
  /**
   * Ids `createEntity` allocated and `deleteEntity` then forgot (removed from
   * `newEntities`, per that method's "existing entities are tombstoned; new
   * entities are simply forgotten" contract). Tracked separately so
   * `getEffectiveChanges()` / `collectEffectiveChanges` can tell "overlay-created
   * then forgotten" apart from "an ordinary source-buffer entity" — both are
   * otherwise indistinguishable, being simply absent from `newEntities`.
   * `restoreNewEntity` (the undo-of-delete counterpart) clears the id back out.
   */
  protected forgottenCreatedEntities: Set<number> = new Set();
  /**
   * Snapshot of a forgotten-created entity's overlay rows, stashed by
   * `deleteEntity` and restored by `restoreNewEntity`.
   *
   * `deleteEntity` on an overlay-created entity does more than drop it from
   * `newEntities` — it also PURGES every other overlay entry the entity left
   * behind (property/quantity/attribute/positional/type mutations, its
   * `newPsets`/`newQsets` entries, and its own `mutationHistory` records).
   * Without that purge, an entity that was created, edited, then deleted
   * before export left a dangling reference: `StepExporter` derives its
   * property/quantity work list from `getMutations()` (the append-only
   * history) and reads `getForEntity()` / `getQuantitiesForEntity()` straight
   * off `newPsets` / `newQsets` — neither of which the review-side
   * `forgottenCreatedEntities` filter in `effective-changes.ts` touches. The
   * review dialog looked clean while the exported file still contained an
   * `IFCPROPERTYSET` + `IFCRELDEFINESBYPROPERTIES` pointing at an expressId
   * that was never actually created (maintainer finding on #1967).
   *
   * The purged data is captured here, not discarded, because `restoreNewEntity`
   * (undo of the delete) must bring it all back — rows AND count AND what the
   * exporter would see — not just re-add the bare `NewEntity` record.
   */
  protected forgottenEntityOverlay: Map<number, ForgottenEntityOverlay> = new Map();
  /**
   * Overlay-entity → source-entity aliases for property/quantity reads.
   *
   * When the viewer duplicates an existing entity, the new entity has
   * no row in the parsed property table — `getBasePropertiesForEntity`
   * would return `[]` and the property panel would show "No property
   * sets". Aliasing redirects the BASE read to the source entity so
   * the duplicate inherits its psets / qsets visually, while overlay
   * mutations (overrides, creates, deletes) stay scoped to the
   * overlay-entity's own id — so editing a property on the duplicate
   * doesn't bleed into the source.
   *
   * Aliases follow at most one hop (no chains). They never affect
   * STEP export — the export overlay emits the duplicate exactly as
   * the StoreEditor recorded it, with whatever new IfcRel*ByProperties
   * the caller chose to add.
   */
  protected entityAliases: Map<number, number> = new Map();
  protected nextAllocatedId: number = 0;
  protected mutationHistory: Mutation[] = [];

  protected setPropertyMutation(entityId: number, key: string, mutation: PropertyMutation): void {
    this.propertyMutations.set(key, mutation);
    let bucket = this.propertyKeysByEntity.get(entityId);
    if (!bucket) {
      bucket = new Set();
      this.propertyKeysByEntity.set(entityId, bucket);
    }
    bucket.add(key);
  }

  protected deletePropertyMutation(entityId: number, key: string): boolean {
    const removed = this.propertyMutations.delete(key);
    if (removed) {
      const bucket = this.propertyKeysByEntity.get(entityId);
      if (bucket) {
        bucket.delete(key);
        if (bucket.size === 0) this.propertyKeysByEntity.delete(entityId);
      }
    }
    return removed;
  }

  protected setQuantityMutation(entityId: number, key: string, mutation: QuantityMutation): void {
    this.quantityMutations.set(key, mutation);
    let bucket = this.quantityKeysByEntity.get(entityId);
    if (!bucket) {
      bucket = new Set();
      this.quantityKeysByEntity.set(entityId, bucket);
    }
    bucket.add(key);
  }

  protected deleteQuantityMutation(entityId: number, key: string): boolean {
    const removed = this.quantityMutations.delete(key);
    if (removed) {
      const bucket = this.quantityKeysByEntity.get(entityId);
      if (bucket) {
        bucket.delete(key);
        if (bucket.size === 0) this.quantityKeysByEntity.delete(entityId);
      }
    }
    return removed;
  }

  /**
   * Capture every overlay row one set owns on one entity (#5965). Deep-copied,
   * so later edits to the live maps cannot reach into a recorded snapshot.
   */
  protected captureSetOverlay(kind: SetOverlaySnapshot['kind'], entityId: number, setName: string): SetOverlaySnapshot {
    const prefix = `${entityId}:${setName}:`;
    const maskKey = `${entityId}:${setName}`;
    const rowsUnder = <M>(keys: Set<string> | undefined, rows: Map<string, M>) =>
      [...(keys ?? [])].filter((key) => key.startsWith(prefix)).map((key): [string, M] => [key, rows.get(key)!]);
    return structuredClone(kind === 'property'
      ? {
        kind, entityId, setName, masked: this.deletedPsets.has(maskKey),
        entries: rowsUnder(this.propertyKeysByEntity.get(entityId), this.propertyMutations),
        created: this.newPsets.get(entityId)?.get(setName) ?? null,
      }
      : {
        kind, entityId, setName, masked: this.deletedQsets.has(maskKey),
        entries: rowsUnder(this.quantityKeysByEntity.get(entityId), this.quantityMutations),
        created: this.newQsets.get(entityId)?.get(setName) ?? null,
      });
  }

  /**
   * Put one set's overlay rows back exactly as `snapshot` captured them,
   * dropping any row the set has gained since. Undo restores a whole-set
   * mutation's `setOverlay.before`, redo its `after` (#5965).
   */
  restoreSetOverlay(snapshot: SetOverlaySnapshot): void {
    const copy = structuredClone(snapshot);
    const { entityId, setName } = copy;
    const prefix = `${entityId}:${setName}:`;
    const maskKey = `${entityId}:${setName}`;
    const [masks, sets] = copy.kind === 'property'
      ? [this.deletedPsets, this.newPsets as Map<number, Map<string, unknown>>]
      : [this.deletedQsets, this.newQsets as Map<number, Map<string, unknown>>];
    if (copy.masked) masks.add(maskKey);
    else masks.delete(maskKey);
    const entitySets = sets.get(entityId) ?? new Map<string, unknown>();
    if (copy.created) entitySets.set(setName, copy.created);
    else entitySets.delete(setName);
    if (entitySets.size > 0) sets.set(entityId, entitySets);
    else sets.delete(entityId);
    if (copy.kind === 'property') {
      for (const key of this.propertyKeysByEntity.get(entityId) ?? []) {
        if (key.startsWith(prefix)) this.deletePropertyMutation(entityId, key);
      }
      for (const [key, row] of copy.entries) this.setPropertyMutation(entityId, key, row);
    } else {
      for (const key of this.quantityKeysByEntity.get(entityId) ?? []) {
        if (key.startsWith(prefix)) this.deleteQuantityMutation(entityId, key);
      }
      for (const [key, row] of copy.entries) this.setQuantityMutation(entityId, key, row);
    }
  }

  /**
   * Record the set's overlay state on either side of a whole-set edit on the
   * mutation it produced, for undo / redo (#5965). `before` is taken first.
   */
  protected stampSetOverlay(mutation: Mutation, before: SetOverlaySnapshot): void {
    mutation.setOverlay = { before, after: this.captureSetOverlay(before.kind, before.entityId, before.setName) };
  }

  /** Whether a base property set is masked by a whole-set deletion. */
  isPropertySetDeleted(entityId: number, psetName: string): boolean {
    return this.deletedPsets.has(`${entityId}:${psetName}`);
  }

  /** Whether a base quantity set is masked by a whole-set deletion. */
  isQuantitySetDeleted(entityId: number, qsetName: string): boolean {
    return this.deletedQsets.has(`${entityId}:${qsetName}`);
  }

  /** Borrowed only for synchronous comparison; never returned to callers. */
  protected overlayState() {
    return {
      propertyMutations: this.propertyMutations,
      quantityMutations: this.quantityMutations,
      propertyKeysByEntity: this.propertyKeysByEntity,
      quantityKeysByEntity: this.quantityKeysByEntity,
      attributeKeysByEntity: this.attributeKeysByEntity,
      deletedPsets: this.deletedPsets,
      deletedQsets: this.deletedQsets,
      newPsets: this.newPsets,
      newQsets: this.newQsets,
      attributeMutations: this.attributeMutations,
      positionalAttrMutations: this.positionalAttrMutations,
      typeMutations: this.typeMutations,
      newEntities: this.newEntities,
      tombstones: this.tombstones,
      forgottenCreatedEntities: this.forgottenCreatedEntities,
      forgottenEntityOverlay: this.forgottenEntityOverlay,
      entityAliases: this.entityAliases,
      nextAllocatedId: this.nextAllocatedId,
      mutationHistory: this.mutationHistory,
    };
  }

  protected copyOverlayState() {
    return structuredClone(this.overlayState());
  }

  protected restoreOverlayState(state: ReturnType<MutableOverlayState['copyOverlayState']>): void {
    Object.assign(this, state);
    // A cloned snapshot carries a plain Map: rebuild the class index (#5413).
    this.newEntities = NewEntityMap.from(this.newEntities);
  }

  protected matchesOverlayState(state: ReturnType<MutableOverlayState['copyOverlayState']>): boolean {
    return sameOverlayValue(this.overlayState(), state);
  }
}
