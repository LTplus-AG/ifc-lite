/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sameOverlayValue } from './overlay-value-equality.js';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { IfcAttributeValue, PropertyMutation, QuantityMutation, AttributeMutation,
  EntityTypeMutation, Mutation, NewEntity } from './types.js';


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
  protected newEntities: Map<number, NewEntity> = new Map();
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
  }

  protected matchesOverlayState(state: ReturnType<MutableOverlayState['copyOverlayState']>): boolean {
    return sameOverlayValue(this.overlayState(), state);
  }
}
