/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { materializeOverlay } from './sparse-overlay.js';
import { withoutEntityExposure } from './entity-read-barrier.js';
import { sameOverlayValue } from './overlay-value-equality.js';
import { NewEntityMap } from './new-entity-map.js';
import { overlayReferenceCandidates } from './overlay-reference-candidates.js';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { IfcAttributeValue, PropertyMutation, QuantityMutation, AttributeMutation,
  EntityTypeMutation, Mutation, SetOverlaySnapshot } from './types.js';
import { quantityKey } from './types.js';


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
  protected propertyTargets: Map<string, readonly [string, string]> = new Map();
  protected quantityTargets: Map<string, readonly [string, string]> = new Map();
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
  // Class and possible-reference rows; no geometry payload is copied here.
  protected overriddenEntities: NewEntityMap = new NewEntityMap();
  protected overriddenSourceIds: Set<number> = new Set();
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
  /** Rows purged when a creation is forgotten; undo-of-delete restores them
   * with their original journal. Omitting the purge leaves dangling exported
   * psets/relationships; omitting the stash loses edits on undo (#1967). */
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

  /** Seed the express-ID allocator above the parsed source. This changes no
   * IFC content; transactions validate the allocator separately from revision. */
  setExpressIdWatermark(maxExistingId: number): void {
    if (maxExistingId > this.nextAllocatedId) {
      this.nextAllocatedId = maxExistingId;
    }
  }

  /** Snapshot candidate ids for effective attribute reads. Includes named,
   * positional and type overrides even when written without journal records;
   * callers apply their normal live-entity and attribute-layout checks. */
  getAttributeOverrideEntityIds(createdTypes?: readonly string[], referencedId?: number): number[] {
    if (createdTypes || referencedId !== undefined) {
      const rows = referencedId === undefined
        ? createdTypes!.flatMap(type => [...this.overriddenEntities.ofType(type)])
        : [...this.overriddenEntities.referencing(referencedId)].filter(row => !createdTypes || createdTypes.some(type => type.toUpperCase() === row.type.toUpperCase()));
      return [...new Set([...rows.map(row => row.expressId), ...this.overriddenSourceIds])];
    }
    return [...new Set([
      ...this.attributeKeysByEntity.keys(),
      ...this.positionalAttrMutations.keys(),
      ...this.typeMutations.keys(),
    ])];
  }

  /** Possible references introduced by overrides. Combine with authored/source
   * reference candidates and verify through the effective record grammar. */
  getAttributeOverrideReferenceCandidates(id: number): number[] {
    return Array.from(this.overriddenEntities.referencing(id), row => row.expressId);
  }
  protected mutationHistory: Mutation[] = [];

  private mutationRevision = 0;

  /** O(1) live-overlay invalidation token, independent of Undo history.
   * Writes, removals and state publications advance it, including skipHistory.
   * Conservative increments may invalidate unchanged geometry; it is never
   * serialized or rewound by Undo/Redo. Detached failed drafts do not affect it.
   */
  getMutationRevision(): number { return this.mutationRevision; }

  /** Read the current quantity override, including explicit unit removal.
   * Unlike the append-only journal, this also reflects skipHistory and Undo. */
  getQuantityMutation(entityId: number, qsetName: string, quantityName: string): Readonly<QuantityMutation> | undefined {
    return this.quantityMutations.get(quantityKey(entityId, qsetName, quantityName));
  }

  protected markOverlayChanged(): void { this.mutationRevision++; }

  /** Narrow creations by effective class; source rows remain conservative
   * candidates because this overlay does not own the immutable source index. */
  protected indexAttributeOverride(entityId: number): void {
    if (!this.attributeKeysByEntity.has(entityId) && !this.positionalAttrMutations.has(entityId) && !this.typeMutations.has(entityId)) {
      this.overriddenEntities.delete(entityId); this.overriddenSourceIds.delete(entityId); return;
    }
    const created = this.newEntities.get(entityId);
    const values: unknown[] = [...(this.positionalAttrMutations.get(entityId)?.values() ?? [])];
    for (const key of this.attributeKeysByEntity.get(entityId) ?? []) values.push(this.attributeMutations.get(key)?.value);
    const type = this.typeMutations.get(entityId)?.newType ?? created?.type ?? '';
    const attributes = overlayReferenceCandidates(values, type.toUpperCase().startsWith('IFCREL'));
    if (created) {
      this.overriddenEntities.set(entityId, { expressId: entityId, type, attributes });
      this.overriddenSourceIds.delete(entityId);
    } else {
      this.overriddenEntities.set(entityId, { expressId: entityId, type: '', attributes });
      this.overriddenSourceIds.add(entityId);
    }
  }

  protected setAttributeMutation(entityId: number, key: string, mutation: AttributeMutation): void {
    this.attributeMutations.set(key, mutation);
    this.markOverlayChanged();
    let bucket = this.attributeKeysByEntity.get(entityId);
    if (!bucket) {
      bucket = new Set();
      this.attributeKeysByEntity.set(entityId, bucket);
    }
    bucket.add(key);
    this.indexAttributeOverride(entityId);
  }

  protected deleteAttributeMutation(entityId: number, key: string): boolean {
    const removed = this.attributeMutations.delete(key);
    if (removed) {
      this.markOverlayChanged();
      const bucket = this.attributeKeysByEntity.get(entityId);
      if (bucket) {
        bucket.delete(key);
        if (bucket.size === 0) this.attributeKeysByEntity.delete(entityId);
      }
      this.indexAttributeOverride(entityId);
    }
    return removed;
  }

  protected setPropertyMutation(entityId: number, key: string, mutation: PropertyMutation, target?: readonly [string, string]): void {
    if (target) this.propertyTargets.set(key, target);
    this.propertyMutations.set(key, mutation);
    this.markOverlayChanged();
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
      this.markOverlayChanged();
      const bucket = this.propertyKeysByEntity.get(entityId);
      if (bucket) {
        bucket.delete(key);
        if (bucket.size === 0) this.propertyKeysByEntity.delete(entityId);
      }
    }
    return removed;
  }

  protected setQuantityMutation(entityId: number, key: string, mutation: QuantityMutation, target?: readonly [string, string]): void {
    if (target) this.quantityTargets.set(key, target);
    this.quantityMutations.set(key, mutation);
    this.markOverlayChanged();
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
      this.markOverlayChanged();
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
    this.markOverlayChanged();
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
      for (const [key, row] of copy.entries) this.setPropertyMutation(entityId, key, row, [setName, key.slice(prefix.length)]);
    } else {
      for (const key of this.quantityKeysByEntity.get(entityId) ?? []) {
        if (key.startsWith(prefix)) this.deleteQuantityMutation(entityId, key);
      }
      for (const [key, row] of copy.entries) this.setQuantityMutation(entityId, key, row, [setName, key.slice(prefix.length)]);
    }
  }

  /**
   * Record the set's overlay state on either side of a whole-set edit on the
   * mutation it produced, for undo / redo (#5965). `before` is taken first.
   */
  protected stampSetOverlay(mutation: Mutation, before: SetOverlaySnapshot): void {
    this.markOverlayChanged();
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
      propertyTargets: this.propertyTargets,
      quantityTargets: this.quantityTargets,
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
      overriddenEntities: this.overriddenEntities,
      overriddenSourceIds: this.overriddenSourceIds,
      tombstones: this.tombstones,
      forgottenCreatedEntities: this.forgottenCreatedEntities,
      forgottenEntityOverlay: this.forgottenEntityOverlay,
      entityAliases: this.entityAliases,
      nextAllocatedId: this.nextAllocatedId,
      mutationHistory: this.mutationHistory,
    };
  }

  protected copyOverlayState(): ReturnType<MutableOverlayState['overlayState']> {
    return withoutEntityExposure(() => structuredClone(materializeOverlay(this.overlayState())));
  }

  protected restoreOverlayState(state: ReturnType<MutableOverlayState['copyOverlayState']>, revision?: number): void {
    Object.assign(this, state);
    // Detached initialization preserves read fingerprints. Live publications
    // still advance the token, including rollback and Undo/Redo.
    if (revision === undefined) this.markOverlayChanged();
    else this.mutationRevision = revision;
    // A cloned snapshot carries a plain Map: rebuild the class index (#5413).
    this.newEntities = NewEntityMap.from(this.newEntities);
    this.overriddenEntities = NewEntityMap.from(this.overriddenEntities);
  }

  protected matchesOverlayState(state: ReturnType<MutableOverlayState['copyOverlayState']>): boolean {
    return withoutEntityExposure(() => sameOverlayValue(this.overlayState(), state));
  }
}
