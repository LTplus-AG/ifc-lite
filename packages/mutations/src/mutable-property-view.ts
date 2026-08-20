/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mutable property view - overlay pattern for property mutations
 *
 * This class provides a mutable view over an immutable PropertyTable.
 * Changes are tracked separately and applied on-the-fly during reads.
 *
 * Supports both pre-built property tables and on-demand property extraction
 * for optimal performance with large models.
 */

import type { PropertyTable, PropertySet, Property, QuantitySet, Quantity } from '@ifc-lite/data';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import type { IfcAttributeValue, PropertyValue, PropertyMutation, QuantityMutation, AttributeMutation, EntityTypeMutation, Mutation, NewEntity, EffectiveChange } from './types.js';
import { propertyKey, quantityKey, attributeKey, generateMutationId } from './types.js';
import { collectEffectiveChanges, type AttributeExtractor } from './effective-changes.js';

export type { AttributeExtractor } from './effective-changes.js';

/**
 * Function type for on-demand property extraction
 * Allows globalId to be optional to match extractPropertiesOnDemand return type
 */
export type PropertyExtractor = (entityId: number) => Array<{
  name: string;
  globalId?: string;
  properties: Array<{ name: string; type: number; value: unknown; dataType?: string }>;
}>;

/**
 * Function type for on-demand quantity extraction
 */
export type QuantityExtractor = (entityId: number) => QuantitySet[];

/**
 * Everything `deleteEntity` purges out of the live overlay maps for a
 * forgotten-created entity, captured so `restoreNewEntity` can put it all
 * back. See the field doc on `MutablePropertyView.forgottenEntityOverlay`.
 */
interface ForgottenEntityOverlay {
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

export class MutablePropertyView {
  private baseTable: PropertyTable | null;
  private onDemandExtractor: PropertyExtractor | null = null;
  private quantityExtractor: QuantityExtractor | null = null;
  private attributeExtractor: AttributeExtractor | null = null;
  private propertyMutations: Map<string, PropertyMutation> = new Map();
  private quantityMutations: Map<string, QuantityMutation> = new Map();
  /**
   * Secondary indices: entityId → mutation keys for that entity.
   *
   * `getForEntity` previously iterated the entire `propertyMutations` /
   * `quantityMutations` map per pset to find newly-added properties — O(M·P)
   * per call. These indices keep that step O(M_entity) instead.
   */
  private propertyKeysByEntity: Map<number, Set<string>> = new Map();
  private quantityKeysByEntity: Map<number, Set<string>> = new Map();
  private attributeKeysByEntity: Map<number, Set<string>> = new Map();
  private deletedPsets: Set<string> = new Set(); // `${entityId}:${psetName}`
  private deletedQsets: Set<string> = new Set(); // `${entityId}:${qsetName}`
  private newPsets: Map<number, Map<string, PropertySet>> = new Map(); // entityId -> psetName -> PropertySet
  private newQsets: Map<number, Map<string, QuantitySet>> = new Map(); // entityId -> qsetName -> QuantitySet
  private attributeMutations: Map<string, AttributeMutation> = new Map(); // `${entityId}:attr:${attrName}`
  private positionalAttrMutations: Map<number, Map<number, IfcAttributeValue>> = new Map(); // entityId -> argIndex -> value
  private typeMutations: Map<number, EntityTypeMutation> = new Map(); // entityId -> retype intent
  private newEntities: Map<number, NewEntity> = new Map();
  private tombstones: Set<number> = new Set();
  /**
   * Ids `createEntity` allocated and `deleteEntity` then forgot (removed from
   * `newEntities`, per that method's "existing entities are tombstoned; new
   * entities are simply forgotten" contract). Tracked separately so
   * `getEffectiveChanges()` / `collectEffectiveChanges` can tell "overlay-created
   * then forgotten" apart from "an ordinary source-buffer entity" — both are
   * otherwise indistinguishable, being simply absent from `newEntities`.
   * `restoreNewEntity` (the undo-of-delete counterpart) clears the id back out.
   */
  private forgottenCreatedEntities: Set<number> = new Set();
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
  private forgottenEntityOverlay: Map<number, ForgottenEntityOverlay> = new Map();
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
  private entityAliases: Map<number, number> = new Map();
  private nextAllocatedId: number = 0;
  private mutationHistory: Mutation[] = [];
  private modelId: string;

  constructor(baseTable: PropertyTable | null, modelId: string) {
    this.baseTable = baseTable;
    this.modelId = modelId;
  }

  /**
   * Seed the express-ID allocator. Should be called once after parsing with
   * the highest existing expressId in the store; subsequent `createEntity`
   * calls allocate IDs strictly above this watermark.
   */
  setExpressIdWatermark(maxExistingId: number): void {
    if (maxExistingId > this.nextAllocatedId) {
      this.nextAllocatedId = maxExistingId;
    }
  }

  /** The next expressId that `createEntity` would allocate. */
  peekNextExpressId(): number {
    return this.nextAllocatedId + 1;
  }

  private setPropertyMutation(entityId: number, key: string, mutation: PropertyMutation): void {
    this.propertyMutations.set(key, mutation);
    let bucket = this.propertyKeysByEntity.get(entityId);
    if (!bucket) {
      bucket = new Set();
      this.propertyKeysByEntity.set(entityId, bucket);
    }
    bucket.add(key);
  }

  private deletePropertyMutation(entityId: number, key: string): boolean {
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

  private setQuantityMutation(entityId: number, key: string, mutation: QuantityMutation): void {
    this.quantityMutations.set(key, mutation);
    let bucket = this.quantityKeysByEntity.get(entityId);
    if (!bucket) {
      bucket = new Set();
      this.quantityKeysByEntity.set(entityId, bucket);
    }
    bucket.add(key);
  }

  private deleteQuantityMutation(entityId: number, key: string): boolean {
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

  private setAttributeMutation(entityId: number, key: string, mutation: AttributeMutation): void {
    this.attributeMutations.set(key, mutation);
    let bucket = this.attributeKeysByEntity.get(entityId);
    if (!bucket) {
      bucket = new Set();
      this.attributeKeysByEntity.set(entityId, bucket);
    }
    bucket.add(key);
  }

  private deleteAttributeMutation(entityId: number, key: string): boolean {
    const removed = this.attributeMutations.delete(key);
    if (removed) {
      const bucket = this.attributeKeysByEntity.get(entityId);
      if (bucket) {
        bucket.delete(key);
        if (bucket.size === 0) this.attributeKeysByEntity.delete(entityId);
      }
    }
    return removed;
  }

  /**
   * Set an on-demand property extractor function
   * This is used when properties are extracted lazily from the source buffer
   */
  setOnDemandExtractor(extractor: PropertyExtractor): void {
    this.onDemandExtractor = extractor;
  }

  /**
   * Set an on-demand quantity extractor function
   */
  setQuantityExtractor(extractor: QuantityExtractor): void {
    this.quantityExtractor = extractor;
  }

  /**
   * Whether this view has anything UNDER its quantity overlay.
   *
   * Properties always do — `getBasePropertiesForEntity` falls back to the
   * `baseTable` the constructor takes — but quantities have only
   * `setQuantityExtractor`, which is opt-in and defaults to `null`. A view
   * without one answers `getQuantitiesForEntity` from the overlay ALONE, so a
   * session that edits one quantity of a source quantity set sees that one
   * quantity and none of its siblings.
   *
   * Exposed so a consumer holding the base data can tell "this entity has no
   * quantities" apart from "this view cannot see them" and supply the missing
   * half rather than write the overlay out as if it were the whole set — which
   * is how a full STEP export deleted a source `IfcElementQuantity`
   * (github.com/LTplus-AG/ifc-lite/issues/2487).
   */
  hasQuantityBase(): boolean {
    return this.quantityExtractor !== null;
  }

  /**
   * Set the base entity-attribute extractor (Name, Description, ObjectType,
   * Tag, ...), used only to resolve `previousValue` in `getEffectiveChanges()`.
   * Without one, attribute `previousValue` falls back to whatever `oldValue`
   * the overlay entry itself carries — which undo can leave stale/absent (see
   * `getEffectiveChanges()` doc).
   */
  setAttributeExtractor(extractor: AttributeExtractor): void {
    this.attributeExtractor = extractor;
  }

  /**
   * Get base properties for an entity (before mutations)
   * Uses on-demand extraction if available, otherwise falls back to base table.
   *
   * Follows the entityAliases map for overlay duplicates so a fresh
   * duplicate inherits its source's psets without paying the cost of
   * eagerly cloning them into the overlay.
   */
  private getBasePropertiesForEntity(entityId: number): PropertySet[] {
    const baseId = this.resolveBaseEntityId(entityId);
    // Prefer on-demand extraction if available (client-side WASM parsing)
    if (this.onDemandExtractor) {
      // Normalize the result to PropertySet[] (globalId defaults to empty string)
      return this.onDemandExtractor(baseId).map(pset => ({
        name: pset.name,
        globalId: pset.globalId || '',
        properties: pset.properties.map(prop => ({
          name: prop.name,
          type: prop.type as PropertyValueType,
          value: prop.value as PropertyValue,
          dataType: prop.dataType,
        })),
      }));
    }
    // Fallback to pre-built property table
    if (this.baseTable) {
      return this.baseTable.getForEntity(baseId);
    }
    return [];
  }

  /**
   * Get all property sets for an entity, with mutations applied
   */
  getForEntity(entityId: number): PropertySet[] {
    const result: PropertySet[] = [];
    const seenPsets = new Set<string>();

    // First, add properties from base (on-demand or table) with mutations applied
    const basePsets = this.getBasePropertiesForEntity(entityId);

    for (const pset of basePsets) {
      // Skip deleted property sets
      if (this.deletedPsets.has(`${entityId}:${pset.name}`)) {
        continue;
      }

      seenPsets.add(pset.name);

      // Apply property mutations
      const mutatedProperties: Property[] = [];
      for (const prop of pset.properties) {
        const key = propertyKey(entityId, pset.name, prop.name);
        const mutation = this.propertyMutations.get(key);

        if (mutation) {
          if (mutation.operation === 'DELETE') {
            continue; // Skip deleted properties
          }
          // Apply SET mutation
          mutatedProperties.push({
            name: prop.name,
            type: mutation.valueType ?? prop.type,
            value: mutation.value ?? null,
            unit: mutation.unit ?? prop.unit,
            dataType: prop.dataType,
          });
        } else {
          mutatedProperties.push(prop);
        }
      }

      // Check for new properties added to this pset. Iterate the per-entity
      // key set so this stays O(M_entity) instead of scanning every mutation
      // in the model.
      const entityPropKeys = this.propertyKeysByEntity.get(entityId);
      if (entityPropKeys) {
        const psetPrefix = `${entityId}:${pset.name}:`;
        for (const key of entityPropKeys) {
          if (!key.startsWith(psetPrefix)) continue;
          const mutation = this.propertyMutations.get(key);
          if (!mutation || mutation.operation !== 'SET') continue;
          const propName = key.slice(psetPrefix.length);
          // Only add if not already in the list
          if (!mutatedProperties.some(p => p.name === propName)) {
            mutatedProperties.push({
              name: propName,
              type: mutation.valueType ?? PropertyValueType.String,
              value: mutation.value ?? null,
              unit: mutation.unit,
            });
          }
        }
      }

      if (mutatedProperties.length > 0) {
        result.push({
          name: pset.name,
          globalId: pset.globalId,
          properties: mutatedProperties,
        });
      }
    }

    // Add new property sets that don't exist in base
    const newPsetsForEntity = this.newPsets.get(entityId);
    if (newPsetsForEntity) {
      for (const [psetName, pset] of newPsetsForEntity) {
        if (!seenPsets.has(psetName)) {
          result.push(pset);
        }
      }
    }

    return result;
  }

  /**
   * Get a specific property value with mutations applied
   */
  getPropertyValue(
    entityId: number,
    psetName: string,
    propName: string
  ): PropertyValue | null {
    const key = propertyKey(entityId, psetName, propName);
    const mutation = this.propertyMutations.get(key);

    if (mutation) {
      if (mutation.operation === 'DELETE') {
        return null;
      }
      return mutation.value ?? null;
    }

    // Check new property sets
    const newPset = this.newPsets.get(entityId)?.get(psetName);
    if (newPset) {
      const prop = newPset.properties.find(p => p.name === propName);
      if (prop) {
        return prop.value;
      }
    }

    // Fall back to on-demand extraction or base table
    const basePsets = this.getBasePropertiesForEntity(entityId);
    const pset = basePsets.find(p => p.name === psetName);
    if (pset) {
      const prop = pset.properties.find(p => p.name === propName);
      if (prop) {
        return prop.value;
      }
    }

    return null;
  }

  /**
   * Set a property value
   * If the property set doesn't exist, creates it automatically
   * @param skipHistory - If true, don't add to mutation history (used for undo/redo)
   */
  setProperty(
    entityId: number,
    psetName: string,
    propName: string,
    value: PropertyValue,
    valueType: PropertyValueType = PropertyValueType.String,
    unit?: string,
    skipHistory: boolean = false
  ): Mutation {
    const key = propertyKey(entityId, psetName, propName);

    // Get old value for undo
    const oldValue = this.getPropertyValue(entityId, psetName, propName);

    // Check if this pset exists in base
    const basePsets = this.getBasePropertiesForEntity(entityId);
    const psetExistsInBase = basePsets.some(p => p.name === psetName);
    const psetExistsInNew = this.newPsets.get(entityId)?.has(psetName);

    // Whether the property already existed BEFORE this call — decided up front
    // because the block below may insert it into `newPsets`. A null value does
    // NOT mean absent (an unset Boolean is present-but-empty), so existence is
    // "had a value OR already an in-session property OR already present in the
    // base pset (even with a null value)" (issue #1107). This drives the CREATE
    // vs UPDATE classification so undo reverts an unset edit instead of
    // deleting the whole property.
    //
    // `oldValue !== null` alone under-detects: a base property that already
    // carries a null value (e.g. an unset Boolean present in the source IFC
    // file, exactly the #1107 shape) makes `getPropertyValue()` return null on
    // the very first edit even though the property genuinely exists — mirrors
    // the `propExistsInBase` check `deleteProperty` below already relies on.
    const propExistedBefore =
      oldValue !== null ||
      basePsets.some(p => p.name === psetName && p.properties.some(prop => prop.name === propName)) ||
      !!this.newPsets.get(entityId)?.get(psetName)?.properties.some(p => p.name === propName);

    // If pset doesn't exist anywhere, create it in newPsets
    if (!psetExistsInBase && !psetExistsInNew) {
      let entityPsets = this.newPsets.get(entityId);
      if (!entityPsets) {
        entityPsets = new Map();
        this.newPsets.set(entityId, entityPsets);
      }
      // Create new property set with this single property
      const pset: PropertySet = {
        name: psetName,
        globalId: `new_${generateMutationId()}`,
        properties: [{
          name: propName,
          type: valueType,
          value: value,
          unit: unit,
        }],
      };
      entityPsets.set(psetName, pset);
    } else if (psetExistsInNew) {
      // If pset exists in newPsets, add/update the property there
      const entityPsets = this.newPsets.get(entityId)!;
      const pset = entityPsets.get(psetName)!;
      const existingPropIndex = pset.properties.findIndex(p => p.name === propName);
      if (existingPropIndex >= 0) {
        pset.properties[existingPropIndex] = {
          name: propName,
          type: valueType,
          value: value,
          unit: unit,
        };
      } else {
        pset.properties.push({
          name: propName,
          type: valueType,
          value: value,
          unit: unit,
        });
      }
    }

    // Always store in propertyMutations for tracking
    this.setPropertyMutation(entityId, key, {
      operation: 'SET',
      value,
      valueType,
      unit,
    });

    const mutation: Mutation = {
      id: generateMutationId(),
      type: propExistedBefore ? 'UPDATE_PROPERTY' : 'CREATE_PROPERTY',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId,
      psetName,
      propName,
      oldValue,
      newValue: value,
      valueType,
    };

    if (!skipHistory) {
      this.mutationHistory.push(mutation);
    }
    return mutation;
  }

  /**
   * Delete a property
   * @param skipHistory - If true, don't add to mutation history (used for undo/redo)
   */
  deleteProperty(entityId: number, psetName: string, propName: string, skipHistory: boolean = false): Mutation | null {
    const key = propertyKey(entityId, psetName, propName);
    const oldValue = this.getPropertyValue(entityId, psetName, propName);

    // A property can legitimately exist with a null value — an unset Boolean
    // added from bSDD lives in `newPsets` with value=null (issue #1107). So
    // "absent" means "no value AND not an in-session property"; keying delete
    // purely on `oldValue === null` made the trash button a silent no-op.
    const inNewPset = !!this.newPsets.get(entityId)?.get(psetName)?.properties.some(p => p.name === propName);
    if (oldValue === null && !inNewPset) {
      return null; // Property doesn't exist
    }

    // A DELETE marker in `propertyMutations` only earns its keep when it is
    // masking a value that genuinely exists in the base data — that's what
    // `getForEntity`'s base-pset walk (and `collectPropertyChanges`) needs to
    // skip. A purely in-session property (added via `setProperty`/
    // `createPropertySet`, never in base) has nothing to mask: leaving a
    // DELETE marker for it kept `collectModifiedEntityIds()` counting this
    // entity as modified with zero effective rows to show for it (the same
    // class of bug as the `newPsets` empty-map leak above, #1967 finding
    // 2(b)) — so drop the mutation entry outright instead.
    const basePsets = this.getBasePropertiesForEntity(entityId);
    const propExistsInBase = basePsets.some(
      p => p.name === psetName && p.properties.some(prop => prop.name === propName),
    );
    if (propExistsInBase) {
      this.setPropertyMutation(entityId, key, { operation: 'DELETE' });
    } else {
      this.deletePropertyMutation(entityId, key);
    }

    // Keep the verbatim newPsets read path (getForEntity / STEP export)
    // consistent with getPropertyValue when the prop lives in an in-session
    // pset: splice it out, and drop the pset if it becomes empty.
    const entityPsets = this.newPsets.get(entityId);
    const newPset = entityPsets?.get(psetName);
    if (entityPsets && newPset) {
      newPset.properties = newPset.properties.filter(p => p.name !== propName);
      if (newPset.properties.length === 0) {
        entityPsets.delete(psetName);
        // An empty Map is still truthy, so leaving it in `newPsets` would keep
        // `collectModifiedEntityIds()` / `hasChanges(entityId)` reporting this
        // entity as modified with zero rows to show for it (maintainer finding
        // 2(b) on #1967 — deleting the last property of an auto-created pset
        // never cleared the entity out of `newPsets`).
        if (entityPsets.size === 0) {
          this.newPsets.delete(entityId);
        }
      }
    }

    const mutation: Mutation = {
      id: generateMutationId(),
      type: 'DELETE_PROPERTY',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId,
      psetName,
      propName,
      oldValue,
      newValue: null,
    };

    if (!skipHistory) {
      this.mutationHistory.push(mutation);
    }
    return mutation;
  }

  /**
   * Create a new property set
   */
  createPropertySet(
    entityId: number,
    psetName: string,
    properties: Array<{ name: string; value: PropertyValue; type?: PropertyValueType; unit?: string }>
  ): Mutation {
    let entityPsets = this.newPsets.get(entityId);
    if (!entityPsets) {
      entityPsets = new Map();
      this.newPsets.set(entityId, entityPsets);
    }

    const pset: PropertySet = {
      name: psetName,
      globalId: `new_${generateMutationId()}`,
      properties: properties.map(p => ({
        name: p.name,
        type: p.type ?? PropertyValueType.String,
        value: p.value,
        unit: p.unit,
      })),
    };

    entityPsets.set(psetName, pset);

    // Also add individual property mutations for consistency
    for (const prop of properties) {
      const key = propertyKey(entityId, psetName, prop.name);
      this.setPropertyMutation(entityId, key, {
        operation: 'SET',
        value: prop.value,
        valueType: prop.type ?? PropertyValueType.String,
        unit: prop.unit,
      });
    }

    const mutation: Mutation = {
      id: generateMutationId(),
      type: 'CREATE_PROPERTY_SET',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId,
      psetName,
      newValue: properties as unknown as PropertyValue,
    };

    this.mutationHistory.push(mutation);
    return mutation;
  }

  /**
   * Delete an entire property set
   */
  deletePropertySet(entityId: number, psetName: string): Mutation {
    // Also remove from new psets if it was created in this session
    const entityPsets = this.newPsets.get(entityId);
    const inSessionPset = entityPsets?.get(psetName);
    if (entityPsets && inSessionPset) {
      entityPsets.delete(psetName);
      // An empty Map is still truthy, so leaving it in `newPsets` would keep
      // `collectModifiedEntityIds()` / `hasChanges(entityId)` reporting this
      // entity as modified with zero rows to show for it (maintainer finding
      // 2(b) on #1967 — the `newPsets` empty-map leak that also affects
      // `deleteProperty`).
      if (entityPsets.size === 0) {
        this.newPsets.delete(entityId);
      }
      // The individual SET mutations `createPropertySet` recorded for this
      // pset's properties have nothing to mask either — same argument as
      // `deleteProperty`'s in-session branch below, applied to every
      // property this in-session pset carried, so drop each entry outright
      // instead of leaving it orphaned in `propertyMutations`.
      for (const prop of inSessionPset.properties) {
        const key = propertyKey(entityId, psetName, prop.name);
        this.deletePropertyMutation(entityId, key);
      }
    }

    // A DELETE marker in `deletedPsets` only earns its keep when it is
    // masking a pset that genuinely exists in the base data — same argument
    // as `deleteProperty` one level down (see the comment above its own
    // base-existence check): a purely in-session pset (added via
    // `createPropertySet`, never in the base file) has nothing to mask, so
    // dropping the pset above already nets to nothing and there is no
    // deletion to report. Recording it as deleted here told the export
    // review a pset would be removed when the net change was zero.
    const existingPsets = this.getBasePropertiesForEntity(entityId);
    const pset = existingPsets.find(p => p.name === psetName);
    if (pset) {
      this.deletedPsets.add(`${entityId}:${psetName}`);
      for (const prop of pset.properties) {
        const key = propertyKey(entityId, psetName, prop.name);
        this.setPropertyMutation(entityId, key, { operation: 'DELETE' });
      }
    }

    const mutation: Mutation = {
      id: generateMutationId(),
      type: 'DELETE_PROPERTY_SET',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId,
      psetName,
    };

    this.mutationHistory.push(mutation);
    return mutation;
  }

  // ---------------------------------------------------------------------------
  // Quantity mutations
  // ---------------------------------------------------------------------------

  /**
   * Get base quantities for an entity (before mutations)
   *
   * Follows the entityAliases map for overlay duplicates so a fresh
   * duplicate inherits its source's qsets.
   */
  private getBaseQuantitiesForEntity(entityId: number): QuantitySet[] {
    const baseId = this.resolveBaseEntityId(entityId);
    if (this.quantityExtractor) {
      return this.quantityExtractor(baseId);
    }
    return [];
  }

  /**
   * Get all quantity sets for an entity, with mutations applied
   */
  getQuantitiesForEntity(entityId: number): QuantitySet[] {
    const result: QuantitySet[] = [];
    const seenQsets = new Set<string>();

    const baseQsets = this.getBaseQuantitiesForEntity(entityId);

    for (const qset of baseQsets) {
      if (this.deletedQsets.has(`${entityId}:${qset.name}`)) continue;

      seenQsets.add(qset.name);

      const mutatedQuantities: Quantity[] = [];
      for (const q of qset.quantities) {
        const key = quantityKey(entityId, qset.name, q.name);
        const mutation = this.quantityMutations.get(key);

        if (mutation) {
          if (mutation.operation === 'DELETE') continue;
          mutatedQuantities.push({
            name: q.name,
            type: mutation.quantityType ?? q.type,
            value: mutation.value ?? q.value,
            unit: mutation.unit ?? q.unit,
          });
        } else {
          mutatedQuantities.push(q);
        }
      }

      // Check for new quantities added to this qset (per-entity index — see
      // the property-mutations site above for rationale).
      const entityQtyKeys = this.quantityKeysByEntity.get(entityId);
      if (entityQtyKeys) {
        const qsetPrefix = `${entityId}:${qset.name}:`;
        for (const key of entityQtyKeys) {
          if (!key.startsWith(qsetPrefix)) continue;
          const mutation = this.quantityMutations.get(key);
          if (!mutation || mutation.operation !== 'SET') continue;
          const quantName = key.slice(qsetPrefix.length);
          if (!mutatedQuantities.some(q => q.name === quantName)) {
            mutatedQuantities.push({
              name: quantName,
              type: mutation.quantityType ?? QuantityType.Count,
              value: mutation.value ?? 0,
              unit: mutation.unit,
            });
          }
        }
      }

      if (mutatedQuantities.length > 0) {
        result.push({ name: qset.name, quantities: mutatedQuantities });
      }
    }

    // Add new quantity sets that don't exist in base
    const newQsetsForEntity = this.newQsets.get(entityId);
    if (newQsetsForEntity) {
      for (const [qsetName, qset] of newQsetsForEntity) {
        if (!seenQsets.has(qsetName)) {
          result.push(qset);
        }
      }
    }

    return result;
  }

  /**
   * Create a new quantity set
   */
  createQuantitySet(
    entityId: number,
    qsetName: string,
    quantities: Array<{ name: string; value: number; quantityType: QuantityType; unit?: string }>
  ): Mutation {
    let entityQsets = this.newQsets.get(entityId);
    if (!entityQsets) {
      entityQsets = new Map();
      this.newQsets.set(entityId, entityQsets);
    }

    const qset: QuantitySet = {
      name: qsetName,
      quantities: quantities.map(q => ({
        name: q.name,
        type: q.quantityType,
        value: q.value,
        unit: q.unit,
      })),
    };

    entityQsets.set(qsetName, qset);

    // Track individual quantity mutations
    for (const q of quantities) {
      const key = quantityKey(entityId, qsetName, q.name);
      this.setQuantityMutation(entityId, key, {
        operation: 'SET',
        value: q.value,
        quantityType: q.quantityType,
        unit: q.unit,
      });
    }

    const mutation: Mutation = {
      id: generateMutationId(),
      type: 'CREATE_QUANTITY',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId,
      psetName: qsetName,
      newValue: quantities as unknown as PropertyValue,
    };

    this.mutationHistory.push(mutation);
    return mutation;
  }

  /**
   * Set a single quantity value (add to existing or new quantity set)
   */
  setQuantity(
    entityId: number,
    qsetName: string,
    quantName: string,
    value: number,
    qType: QuantityType = QuantityType.Count,
    unit?: string,
    skipHistory: boolean = false,
  ): Mutation {
    const key = quantityKey(entityId, qsetName, quantName);

    // Check if qset exists
    const baseQsets = this.getBaseQuantitiesForEntity(entityId);
    const qsetExistsInBase = baseQsets.some(q => q.name === qsetName);
    const qsetExistsInNew = this.newQsets.get(entityId)?.has(qsetName);

    if (!qsetExistsInBase && !qsetExistsInNew) {
      let entityQsets = this.newQsets.get(entityId);
      if (!entityQsets) {
        entityQsets = new Map();
        this.newQsets.set(entityId, entityQsets);
      }
      entityQsets.set(qsetName, {
        name: qsetName,
        quantities: [{ name: quantName, type: qType, value, unit }],
      });
    } else if (qsetExistsInNew) {
      const entityQsets = this.newQsets.get(entityId)!;
      const qset = entityQsets.get(qsetName)!;
      const idx = qset.quantities.findIndex(q => q.name === quantName);
      if (idx >= 0) {
        qset.quantities[idx] = { name: quantName, type: qType, value, unit };
      } else {
        qset.quantities.push({ name: quantName, type: qType, value, unit });
      }
    }

    // Get old value for undo and to determine CREATE vs UPDATE. An overlay
    // mutation (a prior edit this session) wins; otherwise fall back to the
    // base quantity's own value — `qsetExistsInBase` alone is not enough,
    // since a *new* quantity name can be added to an already-existing qset.
    // Without the base-value fallback, the first edit of an existing base
    // quantity reported `oldValue: null` (UPDATE_QUANTITY with nothing to
    // restore), which is exactly the null the viewer's undo handler treats
    // as "nothing to revert to" — undo silently did nothing (#2297 shape).
    const existingMutation = this.quantityMutations.get(key);
    let oldValue: number | null;
    let isUpdate: boolean;
    if (existingMutation) {
      oldValue = existingMutation.value ?? null;
      isUpdate = true;
    } else {
      const baseQuantity = baseQsets
        .find(q => q.name === qsetName)
        ?.quantities.find(q => q.name === quantName);
      oldValue = baseQuantity ? baseQuantity.value : null;
      isUpdate = baseQuantity !== undefined;
    }

    this.setQuantityMutation(entityId, key, {
      operation: 'SET',
      value,
      quantityType: qType,
      unit,
    });

    const mutation: Mutation = {
      id: generateMutationId(),
      type: isUpdate ? 'UPDATE_QUANTITY' : 'CREATE_QUANTITY',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId,
      psetName: qsetName,
      propName: quantName,
      oldValue: oldValue as PropertyValue,
      newValue: value,
      quantityType: qType,
      unit,
    };

    if (!skipHistory) {
      this.mutationHistory.push(mutation);
    }
    return mutation;
  }

  /**
   * Delete an entire quantity set - the inverse of `createQuantitySet`, and the
   * exact mirror of `deletePropertySet` one level up.
   *
   * It was missing until #2508's zone write-back needed it, which is why
   * `deletedQsets` existed but was only ever populated by the restore path.
   * Without it, a writer that REPLACES an entity's quantity set can shrink it
   * but never empty it: re-running with no quantities to write leaves the
   * previous run's numbers in place, so the file states volumes beside a
   * property saying the volume could not be computed.
   */
  deleteQuantitySet(entityId: number, qsetName: string): Mutation {
    // In-session qsets carry their own quantity mutations, recorded by
    // `createQuantitySet`. Drop both, for `deletePropertySet`'s reasons: an
    // empty Map left behind keeps reporting the entity as modified, and an
    // orphaned SET mutation re-adds the quantity to a base qset of the same
    // name.
    const entityQsets = this.newQsets.get(entityId);
    const inSessionQset = entityQsets?.get(qsetName);
    if (entityQsets && inSessionQset) {
      entityQsets.delete(qsetName);
      if (entityQsets.size === 0) {
        this.newQsets.delete(entityId);
      }
      for (const quantity of inSessionQset.quantities) {
        this.deleteQuantityMutation(entityId, quantityKey(entityId, qsetName, quantity.name));
      }
    }

    // A DELETE marker only earns its keep against a qset that genuinely exists
    // in the base file - same argument as `deletePropertySet`'s. A purely
    // in-session qset has nothing to mask, and recording one would tell the
    // export review a set is being removed when the net change is zero.
    const baseQset = this.getBaseQuantitiesForEntity(entityId).find(q => q.name === qsetName);
    if (baseQset) {
      this.deletedQsets.add(`${entityId}:${qsetName}`);
      for (const quantity of baseQset.quantities) {
        this.setQuantityMutation(entityId, quantityKey(entityId, qsetName, quantity.name), { operation: 'DELETE' });
      }
    }

    const mutation: Mutation = {
      // Its OWN type rather than a `DELETE_QUANTITY` with no `propName`: both
      // replay consumers (`applyMutations` here, `change-set-to-ops`) key the
      // member-delete case off `propName`, so a set removal filed under it
      // matched nothing, resurrected the set on import and vanished from a
      // layer publish without reaching `skipped`.
      id: generateMutationId(),
      type: 'DELETE_QUANTITY_SET',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId,
      psetName: qsetName,
    };

    this.mutationHistory.push(mutation);
    return mutation;
  }

  /**
   * Has this entity's quantity set been DELETED this session?
   *
   * `getQuantitiesForEntity` cannot answer it: a deleted set and a set that
   * never existed both come back absent. The exporter needs the difference,
   * because it withholds a source `IfcElementQuantity` when it is writing a
   * REPLACEMENT for it, and a deletion has no replacement to recognise it by.
   * Without this, `deleteQuantitySet` masked a base set in the panel while the
   * exported file still carried it.
   */
  isQuantitySetDeleted(entityId: number, qsetName: string): boolean {
    return this.deletedQsets.has(`${entityId}:${qsetName}`);
  }

  // ---------------------------------------------------------------------------
  // Attribute mutations
  // ---------------------------------------------------------------------------

  /**
   * Set an entity attribute value (Name, Description, ObjectType, Tag, etc.)
   */
  setAttribute(
    entityId: number,
    attrName: string,
    value: string,
    oldValue?: string,
    skipHistory: boolean = false,
  ): Mutation {
    const key = attributeKey(entityId, attrName);

    this.setAttributeMutation(entityId, key, {
      attribute: attrName,
      value,
      oldValue,
    });

    const mutation: Mutation = {
      id: generateMutationId(),
      type: 'UPDATE_ATTRIBUTE',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId,
      attributeName: attrName,
      newValue: value,
      oldValue: oldValue ?? null,
    };

    if (!skipHistory) {
      this.mutationHistory.push(mutation);
    }
    return mutation;
  }

  /**
   * Set a positional STEP argument on an entity by zero-based index.
   *
   * This is the only path for editing non-IfcRoot entities (e.g. profile
   * dimensions on `IfcRectangleProfileDef`) where attributes have no symbolic
   * names. Values follow the same conventions as `NewEntity.attributes`:
   * numbers become `#expressId` references when paired with a reference slot,
   * otherwise REAL/INTEGER literals; strings become quoted STEP strings;
   * `null` becomes `$`.
   */
  setPositionalAttribute(
    entityId: number,
    index: number,
    value: IfcAttributeValue,
    skipHistory: boolean = false,
  ): Mutation {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`setPositionalAttribute: index must be a non-negative integer, got ${index}`);
    }

    let entityMap = this.positionalAttrMutations.get(entityId);
    if (!entityMap) {
      entityMap = new Map();
      this.positionalAttrMutations.set(entityId, entityMap);
    }
    const oldValue = entityMap.has(index) ? entityMap.get(index)! : null;
    entityMap.set(index, value);

    const mutation: Mutation = {
      id: generateMutationId(),
      type: 'UPDATE_POSITIONAL_ATTRIBUTE',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId,
      attributeName: `@${index}`,
      oldValue: oldValue as PropertyValue,
      newValue: value as PropertyValue,
    };

    if (!skipHistory) {
      this.mutationHistory.push(mutation);
    }
    return mutation;
  }

  /** Get all positional argument overrides for an entity, keyed by index. */
  getPositionalMutationsForEntity(entityId: number): Map<number, IfcAttributeValue> | null {
    return this.positionalAttrMutations.get(entityId) ?? null;
  }

  /**
   * Drop a single positional override. Used by undo to roll a
   * setPositionalAttribute back to "no override" when there was no prior
   * value. Mirrors `removeAttributeMutation` for symmetric naming.
   */
  removePositionalMutation(entityId: number, index: number): void {
    const entityMap = this.positionalAttrMutations.get(entityId);
    if (!entityMap) return;
    entityMap.delete(index);
    if (entityMap.size === 0) {
      this.positionalAttrMutations.delete(entityId);
    }
  }

  // ---------------------------------------------------------------------------
  // Entity-type mutations (retype / reassign class)
  // ---------------------------------------------------------------------------

  /**
   * Change an entity's IFC class in place ("retype" / reassign class).
   *
   * The entity keeps its expressId, so its geometry, placement, representation
   * and every `IfcRel*` reference (all keyed by `#id`) carry over unchanged.
   * At export the exporter re-lays-out the entity's attributes BY NAME against
   * the target class's declared attribute list — attributes the target class
   * doesn't have are dropped, missing ones become `$`. This mirrors
   * IfcOpenShell's `ifcopenshell.util.schema.reassign_class`.
   *
   * Intended for compatible reassignments — e.g. the building-element subtypes
   * (`IfcBuildingElementProxy` → `IfcColumn` / `IfcBeam` / `IfcMember` /
   * `IfcPlate` / `IfcWall`) that share the IfcElement attribute layout. For
   * such retypes only the class keyword changes (and an optional PredefinedType).
   *
   * @param newType Target IFC class (canonical PascalCase, e.g. "IfcColumn").
   * @param predefinedType Optional PredefinedType for the target class. Unknown
   *   values fall back to USERDEFINED + ObjectType at export.
   */
  setEntityType(
    entityId: number,
    newType: string,
    predefinedType?: string | null,
    oldType?: string,
    skipHistory: boolean = false,
  ): Mutation {
    if (!newType || typeof newType !== 'string') {
      throw new Error('setEntityType: newType is required');
    }
    const trimmed = newType.trim();
    if (trimmed.length === 0) {
      throw new Error('setEntityType: newType cannot be empty');
    }
    // Validate at the shared boundary — `BulkQueryEngine` calls this directly,
    // bypassing `StoreEditor`'s regex/normalizer checks. Without this, a bulk
    // action could record `Column` and later export `#id=COLUMN(...)`.
    if (!/^[Ii][Ff][Cc][A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) {
      throw new Error(
        `setEntityType: "${newType}" is not a recognizable IFC entity name (expected e.g. "IfcColumn")`,
      );
    }

    // The overlay typeMutation is the single source of truth for the effective
    // class — we deliberately do NOT mutate `NewEntity.type` in place. Its
    // `attributes` stay in the AUTHORED layout, and the exporter re-lays-out
    // from that original type up to the effective type. Keeping the record as
    // the only writer makes `removeTypeMutation` a clean revert (no in-place
    // state to roll back), which undo relies on.
    const newEntity = this.newEntities.get(entityId);
    const existing = this.typeMutations.get(entityId);
    // `baseType` is the ORIGINAL class before any retype (sticky; for display
    // and the new-entity source layout). `prevEffective` is the class right
    // before THIS retype (for granular undo).
    const baseType = existing?.oldType ?? oldType ?? newEntity?.type;
    const prevEffective = existing?.newType ?? baseType;

    this.typeMutations.set(entityId, {
      newType: trimmed,
      oldType: baseType,
      predefinedType: predefinedType ?? null,
    });

    const mutation: Mutation = {
      id: generateMutationId(),
      type: 'UPDATE_ENTITY_TYPE',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId,
      entityType: trimmed,
      predefinedType: predefinedType ?? null,
      newValue: trimmed,
      oldValue: prevEffective ?? null,
    };

    if (!skipHistory) {
      this.mutationHistory.push(mutation);
    }
    return mutation;
  }

  /** Get the retype intent for an entity, or null if it hasn't been retyped. */
  getEntityTypeMutation(entityId: number): EntityTypeMutation | null {
    return this.typeMutations.get(entityId) ?? null;
  }

  /** All retype intents, keyed by expressId. Returns a defensive copy. */
  getTypeMutations(): Map<number, EntityTypeMutation> {
    return new Map(this.typeMutations);
  }

  /**
   * Drop a retype intent, reverting the entity to its original class. Because
   * `setEntityType` never mutates `NewEntity.type` in place, this is a complete
   * revert for both source-buffer and overlay-created entities — nothing else
   * to roll back.
   */
  removeTypeMutation(entityId: number): void {
    this.typeMutations.delete(entityId);
  }

  // ---------------------------------------------------------------------------
  // Entity-level mutations (create / delete)
  // ---------------------------------------------------------------------------

  /**
   * Create a new entity in the overlay. Returns the freshly-allocated
   * expressId. Callers must ensure `setExpressIdWatermark` has been seeded
   * from the underlying store before calling this for the first time.
   */
  createEntity(type: string, attributes: IfcAttributeValue[]): NewEntity {
    if (!type || typeof type !== 'string') {
      throw new Error('createEntity: type is required');
    }
    // Preserve the type string the caller passed (canonical PascalCase per
    // the public contract). UPPERCASE STEP tokens still work because the
    // STEP exporter upper-cases at write time — but `NewEntity.type` no
    // longer mangles `IfcColumn` into `IFCCOLUMN` for downstream consumers.
    const expressId = ++this.nextAllocatedId;
    const entity: NewEntity = {
      expressId,
      type: type.trim(),
      attributes: attributes.slice(),
    };
    this.newEntities.set(expressId, entity);

    this.mutationHistory.push({
      id: generateMutationId(),
      type: 'CREATE_ENTITY',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId: expressId,
      attributeName: entity.type,
    });
    return entity;
  }

  /**
   * Mark an entity for deletion. Returns false if the id is unknown to this
   * view, or was already tombstoned.
   *
   * An overlay-created entity is dropped from `newEntities` — so it is emitted
   * nowhere, which is the right answer for something created and deleted in one
   * session — AND tombstoned, so `isDeleted` tells the truth about it.
   *
   * It used to be only forgotten, and that made `isDeleted` lie: every guard
   * that asks "was this deleted" got `false` for an entity that no longer
   * exists, so the export still emitted the `IFCRELDEFINESBYPROPERTIES` for a
   * pset queued on it, dangling at a record nothing wrote (#2012). Forgetting
   * without tombstoning cannot be made safe one guard at a time, because the
   * question the guards ask has no true answer to find.
   *
   * Consumers that count entities must therefore intersect tombstones with the
   * source store rather than subtracting `tombstones.size` wholesale — a
   * created-then-deleted id is absent from BOTH the store and `getNewEntities`,
   * so counting it as a deletion would subtract it twice.
   */
  deleteEntity(expressId: number): boolean {
    if (this.newEntities.has(expressId)) {
      this.newEntities.delete(expressId);
      // Both sets are needed: `tombstones` is what the unified isDeleted() /
      // getEffectiveEntityIndex() answer from (#2036), while
      // `forgottenCreatedEntities` is what collectEffectiveChanges()'s row
      // filter uses to drop ALL rows for a created-then-deleted entity
      // (create and delete cancel out) rather than keeping an entity-deleted
      // row the way a tombstoned source entity does.
      this.tombstones.add(expressId);
      this.forgottenCreatedEntities.add(expressId);
      // Purge every other overlay trace of this entity — property/quantity/
      // attribute/positional/type mutations, `newPsets`/`newQsets`, and this
      // entity's own mutation-history records — BEFORE pushing the
      // DELETE_ENTITY record below, so that record is the only history entry
      // left for this id. See `forgottenEntityOverlay`'s doc for why this is
      // a stash-and-remove rather than an outright discard.
      this.stashAndPurgeEntityOverlay(expressId);
      this.mutationHistory.push({
        id: generateMutationId(),
        type: 'DELETE_ENTITY',
        timestamp: Date.now(),
        modelId: this.modelId,
        entityId: expressId,
      });
      return true;
    }
    if (this.tombstones.has(expressId)) return false;
    this.tombstones.add(expressId);
    this.mutationHistory.push({
      id: generateMutationId(),
      type: 'DELETE_ENTITY',
      timestamp: Date.now(),
      modelId: this.modelId,
      entityId: expressId,
    });
    return true;
  }

  /** Returns all overlay-created entities in insertion order. */
  getNewEntities(): NewEntity[] {
    return Array.from(this.newEntities.values());
  }

  /** Look up a single overlay-created entity. */
  getNewEntity(expressId: number): NewEntity | null {
    return this.newEntities.get(expressId) ?? null;
  }

  isDeleted(expressId: number): boolean {
    return this.tombstones.has(expressId);
  }

  /**
   * Reverse `deleteEntity` for an existing-entity tombstone. Returns true if
   * a tombstone was removed; false if the id was not tombstoned. Used by
   * undo of a DELETE_ENTITY mutation on a source-buffer entity. Overlay-only
   * entities are restored via a separate path (`restoreNewEntity`).
   */
  restoreFromTombstone(expressId: number): boolean {
    return this.tombstones.delete(expressId);
  }

  /**
   * Alias an overlay-only entity to a source entity for property /
   * quantity reads. Used by the duplicate flow so a fresh duplicate
   * inherits its source's psets / qsets in the property panel without
   * eagerly cloning them. Edits on the duplicate stay scoped to the
   * duplicate's own id (override slots are keyed by entity id, not
   * by base id).
   *
   * Pass `null` as the source to clear an existing alias.
   */
  setEntityAlias(overlayId: number, sourceId: number | null): void {
    if (sourceId === null) {
      this.entityAliases.delete(overlayId);
      return;
    }
    if (sourceId === overlayId) return;
    this.entityAliases.set(overlayId, sourceId);
  }

  /** Read the alias for a given overlay id, or null if none. */
  getEntityAlias(overlayId: number): number | null {
    return this.entityAliases.get(overlayId) ?? null;
  }

  /**
   * Resolve to the base id used for property/quantity reads. Returns
   * the input id when no alias is set. Aliases follow at most one
   * hop — chained duplicates resolve to their immediate source, not
   * the original.
   */
  resolveBaseEntityId(entityId: number): number {
    return this.entityAliases.get(entityId) ?? entityId;
  }

  /**
   * Re-add an overlay-only entity to `newEntities`. Pairs with `deleteEntity`
   * to support undo of a freshly-created-and-then-deleted entity. The caller
   * is responsible for stashing the `NewEntity` record between delete and
   * restore (the slice's undo stack does this).
   */
  restoreNewEntity(entity: NewEntity): void {
    this.newEntities.set(entity.expressId, entity);
    // `deleteEntity` both tombstones an overlay-created entity (for the
    // unified isDeleted() / getEffectiveEntityIndex() answer) and forgets it
    // (for collectEffectiveChanges()'s row filter), so the inverse has to
    // clear both — otherwise the restored record is either still "deleted"
    // per isDeleted() (stale tombstone) or still invisible to the review
    // diff (stale forgotten-entity mark).
    this.tombstones.delete(entity.expressId);
    this.forgottenCreatedEntities.delete(entity.expressId);
    // Without this the next createEntity() can hand out the same id and
    // overwrite the restored entity.
    if (entity.expressId > this.nextAllocatedId) {
      this.nextAllocatedId = entity.expressId;
    }
    // Bring back whatever `deleteEntity` purged (property/quantity/attribute
    // mutations, newPsets/newQsets, history) — a no-op if this entity was
    // never forgotten (e.g. a plain create with nothing purged).
    this.unstashEntityOverlay(entity.expressId);
  }

  /**
   * Move every current overlay entry for `expressId` out of the live maps
   * and into `forgottenEntityOverlay`, and drop this entity's own records
   * from `mutationHistory`. Called by `deleteEntity` when it forgets a
   * created entity. Only stashes a key if something was actually captured,
   * so `unstashEntityOverlay` on a plain (never-edited) create is a no-op.
   */
  private stashAndPurgeEntityOverlay(expressId: number): void {
    const stash: ForgottenEntityOverlay = {
      propertyEntries: [],
      quantityEntries: [],
      attributeEntries: [],
      positionalAttrs: null,
      typeMutation: null,
      newPsets: null,
      newQsets: null,
      deletedPsetKeys: [],
      deletedQsetKeys: [],
      historyEntries: [],
    };

    for (const key of Array.from(this.propertyKeysByEntity.get(expressId) ?? [])) {
      const mutation = this.propertyMutations.get(key);
      if (mutation) stash.propertyEntries.push([key, mutation]);
      this.deletePropertyMutation(expressId, key);
    }

    for (const key of Array.from(this.quantityKeysByEntity.get(expressId) ?? [])) {
      const mutation = this.quantityMutations.get(key);
      if (mutation) stash.quantityEntries.push([key, mutation]);
      this.deleteQuantityMutation(expressId, key);
    }

    for (const key of Array.from(this.attributeKeysByEntity.get(expressId) ?? [])) {
      const mutation = this.attributeMutations.get(key);
      if (mutation) stash.attributeEntries.push([key, mutation]);
      this.deleteAttributeMutation(expressId, key);
    }

    const positional = this.positionalAttrMutations.get(expressId);
    if (positional) {
      stash.positionalAttrs = new Map(positional);
      this.positionalAttrMutations.delete(expressId);
    }

    const typeMutation = this.typeMutations.get(expressId);
    if (typeMutation) {
      stash.typeMutation = typeMutation;
      this.typeMutations.delete(expressId);
    }

    const psets = this.newPsets.get(expressId);
    if (psets) {
      stash.newPsets = new Map(psets);
      this.newPsets.delete(expressId);
    }

    const qsets = this.newQsets.get(expressId);
    if (qsets) {
      stash.newQsets = new Map(qsets);
      this.newQsets.delete(expressId);
    }

    const psetPrefix = `${expressId}:`;
    for (const key of Array.from(this.deletedPsets)) {
      if (!key.startsWith(psetPrefix)) continue;
      stash.deletedPsetKeys.push(key);
      this.deletedPsets.delete(key);
    }
    for (const key of Array.from(this.deletedQsets)) {
      if (!key.startsWith(psetPrefix)) continue;
      stash.deletedQsetKeys.push(key);
      this.deletedQsets.delete(key);
    }

    const keptHistory: Mutation[] = [];
    for (const mutation of this.mutationHistory) {
      if (mutation.entityId === expressId) {
        stash.historyEntries.push(mutation);
      } else {
        keptHistory.push(mutation);
      }
    }
    this.mutationHistory = keptHistory;

    const hasStashedData =
      stash.propertyEntries.length > 0 ||
      stash.quantityEntries.length > 0 ||
      stash.attributeEntries.length > 0 ||
      stash.positionalAttrs !== null ||
      stash.typeMutation !== null ||
      stash.newPsets !== null ||
      stash.newQsets !== null ||
      stash.deletedPsetKeys.length > 0 ||
      stash.deletedQsetKeys.length > 0 ||
      stash.historyEntries.length > 0;
    if (hasStashedData) {
      this.forgottenEntityOverlay.set(expressId, stash);
    }
  }

  /**
   * Reverse `stashAndPurgeEntityOverlay`: put everything `deleteEntity`
   * purged back into the live overlay maps. Called by `restoreNewEntity`.
   * A no-op if nothing was stashed for `expressId`.
   */
  private unstashEntityOverlay(expressId: number): void {
    const stash = this.forgottenEntityOverlay.get(expressId);
    if (!stash) return;
    this.forgottenEntityOverlay.delete(expressId);

    for (const [key, mutation] of stash.propertyEntries) this.setPropertyMutation(expressId, key, mutation);
    for (const [key, mutation] of stash.quantityEntries) this.setQuantityMutation(expressId, key, mutation);
    for (const [key, mutation] of stash.attributeEntries) this.setAttributeMutation(expressId, key, mutation);
    if (stash.positionalAttrs) this.positionalAttrMutations.set(expressId, stash.positionalAttrs);
    if (stash.typeMutation) this.typeMutations.set(expressId, stash.typeMutation);
    if (stash.newPsets) this.newPsets.set(expressId, stash.newPsets);
    if (stash.newQsets) this.newQsets.set(expressId, stash.newQsets);
    for (const key of stash.deletedPsetKeys) this.deletedPsets.add(key);
    for (const key of stash.deletedQsetKeys) this.deletedQsets.add(key);

    // The DELETE_ENTITY `deleteEntity` pushed AFTER the purge (so it would be
    // the only history entry left for this id) is superseded by this
    // restore — same reasoning `forgottenCreatedEntities` already applies to
    // collectEffectiveChanges()'s row filter one layer down: a create and
    // its delete cancel, they don't survive as a create followed by a delete.
    // Re-appending the stashed CREATE_ENTITY/CREATE_PROPERTY records BEHIND
    // that DELETE_ENTITY (the old bug) reordered mutationHistory to
    // DELETE_ENTITY,CREATE_ENTITY,..., which defeats applyMutations()'s
    // skippedCreateIds guard (#2036) on replay: the DELETE_ENTITY is seen
    // before the CREATE_ENTITY it should pair with, so it tombstones an id
    // that was never really deleted — silent data loss through
    // exportMutations()/importMutations() on a published package.
    this.mutationHistory = this.mutationHistory.filter(
      m => !(m.entityId === expressId && m.type === 'DELETE_ENTITY')
    );
    if (stash.historyEntries.length > 0) this.mutationHistory.push(...stash.historyEntries);
  }

  /**
   * Every express id this session deleted — source-buffer entities AND ones it
   * created and then deleted. The two are not distinguishable from this set
   * alone; a caller that needs to tell them apart intersects it with the store's
   * own index (see `deleteEntity`).
   */
  getTombstones(): Set<number> {
    return new Set(this.tombstones);
  }

  /**
   * Get mutated attributes for an entity.
   * Returns only attributes that have been added/modified via mutations.
   */
  getAttributeMutationsForEntity(entityId: number): Array<{ name: string; value: string }> {
    const result: Array<{ name: string; value: string }> = [];
    for (const key of this.attributeKeysByEntity.get(entityId) ?? []) {
      const mutation = this.attributeMutations.get(key);
      if (mutation) result.push({ name: mutation.attribute, value: mutation.value });
    }
    return result;
  }

  /**
   * Every attribute override currently in the overlay, keyed by entity then
   * attribute name.
   *
   * This is the *current* overlay state, not the append-only mutation history:
   * an undone edit has had its overlay entry reset to the pre-edit value (or
   * removed outright), so it does not appear here, whereas its superseded
   * `UPDATE_ATTRIBUTE` record lives on in {@link getMutations} forever. Export
   * must read this — replaying the history resurrects undone edits (#1957).
   */
  getAttributeMutationsByEntity(): Map<number, Map<string, string>> {
    const result = new Map<number, Map<string, string>>();
    for (const entityId of this.attributeKeysByEntity.keys()) {
      const attrs = new Map<string, string>();
      for (const { name, value } of this.getAttributeMutationsForEntity(entityId)) {
        attrs.set(name, value);
      }
      if (attrs.size > 0) result.set(entityId, attrs);
    }
    return result;
  }

  /**
   * Remove a quantity mutation (used by undo for newly created quantities)
   */
  removeQuantityMutation(entityId: number, qsetName: string, quantName?: string): void {
    if (quantName) {
      const key = quantityKey(entityId, qsetName, quantName);
      this.deleteQuantityMutation(entityId, key);
      // Also remove from newQsets if present
      const entityQsets = this.newQsets.get(entityId);
      if (entityQsets) {
        const qset = entityQsets.get(qsetName);
        if (qset) {
          qset.quantities = qset.quantities.filter(q => q.name !== quantName);
          if (qset.quantities.length === 0) {
            entityQsets.delete(qsetName);
            // Same empty-Map trap as `deleteProperty`/`newPsets` (#1967
            // finding 2(b)) — an empty Map is still truthy, so leave no
            // trace of this entity in `newQsets` once its last qset is gone.
            if (entityQsets.size === 0) {
              this.newQsets.delete(entityId);
            }
          }
        }
      }
    } else {
      // Remove entire quantity set
      const entityQsets = this.newQsets.get(entityId);
      if (entityQsets) {
        entityQsets.delete(qsetName);
        if (entityQsets.size === 0) {
          this.newQsets.delete(entityId);
        }
      }
      // Remove all quantity mutations for this qset (only those for this entity).
      const bucket = this.quantityKeysByEntity.get(entityId);
      if (bucket) {
        const prefix = `${entityId}:${qsetName}:`;
        const toRemove: string[] = [];
        for (const key of bucket) {
          if (key.startsWith(prefix)) toRemove.push(key);
        }
        for (const key of toRemove) {
          this.deleteQuantityMutation(entityId, key);
        }
      }
    }
  }

  /**
   * Remove an attribute mutation (used by undo for newly set attributes)
   */
  removeAttributeMutation(entityId: number, attrName: string): void {
    this.deleteAttributeMutation(entityId, attributeKey(entityId, attrName));
  }

  /**
   * Get all mutations applied to this view
   */
  getMutations(): Mutation[] {
    return [...this.mutationHistory];
  }

  /**
   * Get mutations for a specific entity
   */
  getMutationsForEntity(entityId: number): Mutation[] {
    return this.mutationHistory.filter(m => m.entityId === entityId);
  }

  /**
   * Check if an entity currently carries an overlay change.
   *
   * Reads the live overlay (same footprint as {@link hasPendingChanges}),
   * NOT the append-only `mutationHistory` — undo does not pop history (see
   * `getMutations()`), so a history-based check could report `true` for an
   * entity whose edit was fully undone. Called with no `entityId`, this is
   * exactly {@link hasPendingChanges}.
   *
   * Unlike {@link getModifiedEntityCount} (derived from
   * {@link getEffectiveChanges} so it can't diverge), this is a direct
   * per-entity map lookup kept O(1)-ish for callers that probe many entities
   * (e.g. a per-row "has changes" indicator) — re-deriving effective changes
   * per call would be O(overlay size) each time. That means it can still
   * report `true` for an entity whose only overlay entry is a no-op edit
   * (undo landed it back at the base value, so `previousValue === newValue`
   * — see {@link getEffectiveChanges}'s doc). Over-reporting here is the same
   * safe direction {@link hasPendingChanges} already documents; nothing in
   * this repo reads this per-entity form in production as of #1967.
   */
  hasChanges(entityId?: number): boolean {
    if (entityId === undefined) {
      return this.hasPendingChanges();
    }
    // A create->delete entity is forgotten, not tombstoned (see `deleteEntity`),
    // so any other per-entity map entries it left behind (attribute/property/
    // quantity edits made before the delete) are orphaned — they belong to an
    // entity that will never be exported. `getEffectiveChanges()` already drops
    // every row for these ids with no exception; this must agree (issue: the
    // #1915 forgotten-created blind spot). `restoreNewEntity` removes the id
    // from this set, so a restored entity falls through to the checks below
    // exactly as before.
    if (this.forgottenCreatedEntities.has(entityId)) return false;
    if (this.propertyKeysByEntity.has(entityId)) return true;
    if (this.quantityKeysByEntity.has(entityId)) return true;
    if (this.positionalAttrMutations.has(entityId)) return true;
    if (this.typeMutations.has(entityId)) return true;
    if (this.newPsets.has(entityId)) return true;
    if (this.newQsets.has(entityId)) return true;
    if (this.newEntities.has(entityId)) return true;
    if (this.tombstones.has(entityId)) return true;
    const attrPrefix = `${entityId}:attr:`;
    for (const key of this.attributeMutations.keys()) {
      if (key.startsWith(attrPrefix)) return true;
    }
    const setPrefix = `${entityId}:`;
    for (const key of this.deletedPsets) {
      if (key.startsWith(setPrefix)) return true;
    }
    for (const key of this.deletedQsets) {
      if (key.startsWith(setPrefix)) return true;
    }
    return false;
  }

  /**
   * True when the overlay currently carries anything the STEP exporter would
   * bake (property/quantity overrides, attribute / positional / type edits,
   * pset/qset creates or deletes, or overlay-created/tombstoned entities).
   *
   * Unlike {@link getMutations} / {@link hasChanges}, this reflects the *current
   * overlay footprint* — the same set {@link clear} resets and the exporter
   * reads — rather than the append-only mutation history, which never shrinks.
   * It is deliberately a conservative over-approximation: undoing an edit resets
   * the overlay entry's value (or leaves a no-op DELETE marker) instead of
   * removing it, so a fully-reverted model can still report `true`. That is the
   * safe direction for gating an export bake — over-reporting only costs a
   * redundant (identical-output) re-bake, whereas under-reporting would silently
   * drop edits.
   */
  hasPendingChanges(): boolean {
    return (
      this.propertyMutations.size > 0 ||
      this.quantityMutations.size > 0 ||
      this.attributeMutations.size > 0 ||
      this.positionalAttrMutations.size > 0 ||
      this.typeMutations.size > 0 ||
      this.newPsets.size > 0 ||
      this.newQsets.size > 0 ||
      this.deletedPsets.size > 0 ||
      this.deletedQsets.size > 0 ||
      this.newEntities.size > 0 ||
      this.tombstones.size > 0
    );
  }

  /**
   * Get count of modified entities.
   *
   * Reads the live overlay, NOT `mutationHistory` (issue #1915): undo does
   * not pop history, so a history-based count could over-report — e.g. after
   * `setAttribute` + `removeAttributeMutation` (exactly what undoing a
   * freshly-created attribute mutation does), the overlay is empty again but
   * history still holds the one entry. This must agree with
   * {@link hasPendingChanges}: zero here iff that is `false`.
   *
   * Must also agree with {@link getEffectiveChanges} — an entity contributing
   * zero effective rows (a create -> edit -> delete `deleteEntity` forgot, or
   * an edit fully undone back to its base value) must not be counted here
   * either. `collectModifiedEntityIds` is deliberately DERIVED FROM
   * `getEffectiveChanges()` rather than hand-walking the overlay maps a
   * second time, so the two structurally cannot diverge again (issue: the
   * #1915 forgotten-created blind spot, and the #1967 no-op-edit blind spot
   * that a second hand-rolled walk reintroduced).
   */
  getModifiedEntityCount(): number {
    return this.collectModifiedEntityIds().size;
  }

  /** Distinct entity ids with at least one row in {@link getEffectiveChanges}. */
  private collectModifiedEntityIds(): Set<number> {
    const ids = new Set<number>();
    for (const change of this.getEffectiveChanges()) ids.add(change.entityId);
    return ids;
  }

  /**
   * Enumerate every change the overlay currently carries, as it stands right
   * now — never from `mutationHistory` (see {@link getModifiedEntityCount}).
   * This is what the export-review UI (issue #1915) and any snapshot test
   * should read: `previousValue` is derived from the base data (property
   * table / on-demand extractor / attribute extractor), so an undo→redo
   * cycle reports the true original, not a stale history entry.
   *
   * Whole-pset/qset deletes and creates are reported as a single
   * `pset-added` / `pset-deleted` / `qset-added` / `qset-deleted` row rather
   * than one row per property/quantity inside them (deletePropertySet /
   * createPropertySet also populate individual property/quantity mutations
   * internally — those are intentionally not double-reported here).
   *
   * Deterministic ordering: entityId, then kind, then name, then setName.
   */
  getEffectiveChanges(): EffectiveChange[] {
    return collectEffectiveChanges(
      {
        attributeMutations: this.attributeMutations,
        positionalAttrMutations: this.positionalAttrMutations,
        typeMutations: this.typeMutations,
        newPsets: this.newPsets,
        deletedPsets: this.deletedPsets,
        newQsets: this.newQsets,
        deletedQsets: this.deletedQsets,
        propertyKeysByEntity: this.propertyKeysByEntity,
        propertyMutations: this.propertyMutations,
        quantityKeysByEntity: this.quantityKeysByEntity,
        quantityMutations: this.quantityMutations,
        newEntities: this.newEntities,
        tombstones: this.tombstones,
        forgottenCreatedEntities: this.forgottenCreatedEntities,
      },
      {
        attributeExtractor: this.attributeExtractor,
        resolveBaseEntityId: (entityId: number) => this.resolveBaseEntityId(entityId),
        getBasePropertiesForEntity: (entityId: number) => this.getBasePropertiesForEntity(entityId),
        getBaseQuantitiesForEntity: (entityId: number) => this.getBaseQuantitiesForEntity(entityId),
      },
    );
  }

  /**
   * Clear all mutations (reset to base state)
   */
  clear(): void {
    this.propertyMutations.clear();
    this.quantityMutations.clear();
    this.propertyKeysByEntity.clear();
    this.quantityKeysByEntity.clear();
    this.attributeMutations.clear();
    this.attributeKeysByEntity.clear();
    this.deletedPsets.clear();
    this.deletedQsets.clear();
    this.newPsets.clear();
    this.newQsets.clear();
    this.positionalAttrMutations.clear();
    this.typeMutations.clear();
    this.newEntities.clear();
    this.tombstones.clear();
    this.forgottenCreatedEntities.clear();
    this.forgottenEntityOverlay.clear();
    this.entityAliases.clear();
    this.nextAllocatedId = 0;
    this.mutationHistory = [];
  }

  /**
   * Apply a batch of mutations (e.g., from imported change set)
   */
  applyMutations(mutations: Mutation[]): void {
    // CREATE_ENTITY records are skipped (callers must restore the
    // payload via restoreNewEntity). Track the ids we've skipped so a
    // matching DELETE_ENTITY in the same batch doesn't tombstone an
    // entity that never made it into this view — that stale tombstone
    // would later suppress a freshly-allocated overlay entity reusing
    // the same expressId.
    // Pass 1: collect every CREATE_ENTITY id up front, over the whole
    // array, before applying anything. CREATE_ENTITY is unconditionally
    // skipped below (every id it's called for lands here) — but a caller
    // supplying an arbitrary (e.g. imported/merged) Mutation[] may not have
    // its CREATE_ENTITY appear before the mutations that depend on it. A
    // single incremental forward pass would only "see" a create once the
    // loop reaches it, so a dependent mutation earlier in the array would
    // replay before its own entity's creation was known to be skipped —
    // reproducing the orphaned-pset bug via ordering instead of via the
    // original bug shape. Doing the full collection first makes the result
    // order-independent.
    const skippedCreateIds = new Set<number>();
    for (const mutation of mutations) {
      if (mutation.type === 'CREATE_ENTITY') {
        skippedCreateIds.add(mutation.entityId);
      }
    }

    // Pass 2: apply mutations against the now-complete skip set.
    for (const mutation of mutations) {
      // Any mutation recorded against an entity whose own CREATE_ENTITY was
      // skipped above would otherwise replay into an orphan — a pset (or
      // attribute/quantity/type edit) keyed to an expressId that exists in
      // neither the source buffer nor `newEntities`. Refuse those too, so
      // the round trip is lossy (entity + its edits both dropped) rather
      // than corrupting (edits surviving without their entity). This keys
      // off `skippedCreateIds`, not "id absent from newEntities", so a
      // mutation against a normal, pre-existing source-buffer entity is
      // never affected — only ids that had their own CREATE_ENTITY skipped
      // in this same batch land here.
      // The `newEntities` check makes the condition "the create was skipped
      // AND nothing else supplied the entity". A caller following the
      // documented recovery flow calls `restoreNewEntity()` first and
      // *then* replays the history; the id is live by the time we get here,
      // so there is no orphan to guard against and dropping its edits would
      // silently lose data on the exact path the console.warn recommends.
      if (
        mutation.type !== 'CREATE_ENTITY' &&
        skippedCreateIds.has(mutation.entityId) &&
        !this.newEntities.has(mutation.entityId)
      ) {
        continue;
      }
      switch (mutation.type) {
        case 'CREATE_PROPERTY':
        case 'UPDATE_PROPERTY':
          if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
            this.setProperty(
              mutation.entityId,
              mutation.psetName,
              mutation.propName,
              mutation.newValue,
              mutation.valueType
            );
          }
          break;

        case 'DELETE_PROPERTY':
          if (mutation.psetName && mutation.propName) {
            this.deleteProperty(mutation.entityId, mutation.psetName, mutation.propName);
          }
          break;

        case 'DELETE_PROPERTY_SET':
          if (mutation.psetName) {
            this.deletePropertySet(mutation.entityId, mutation.psetName);
          }
          break;

        case 'DELETE_QUANTITY_SET':
          if (mutation.psetName) {
            this.deleteQuantitySet(mutation.entityId, mutation.psetName);
            // The marker is recorded even when this view cannot SEE the base
            // set, unlike the live path. `deleteQuantitySet` only masks a set
            // the quantity extractor reports, and that extractor is opt-in
            // (null by default, and several in-tree callers wire the property
            // one beside it and not it). A replayed deletion is a decision the
            // origin session already made, so dropping it here would let a
            // later export regenerate a set the user removed. An inert marker
            // on a set that does not exist costs a row in the change list;
            // losing the deletion costs the user's edit.
            this.deletedQsets.add(`${mutation.entityId}:${mutation.psetName}`);
          }
          break;

        case 'CREATE_QUANTITY':
        case 'UPDATE_QUANTITY':
          if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
            this.setQuantity(
              mutation.entityId,
              mutation.psetName,
              mutation.propName,
              Number(mutation.newValue),
              (mutation.quantityType as QuantityType) ?? QuantityType.Count,
              mutation.unit,
            );
          } else if (
            mutation.type === 'CREATE_QUANTITY' &&
            mutation.psetName &&
            Array.isArray(mutation.newValue)
          ) {
            // `createQuantitySet()` (whole-qset creation, e.g.
            // `StoreEditor.addQuantitySet`) records ONE CREATE_QUANTITY mutation
            // for the whole set — no `propName`, `newValue` is the full
            // quantities array — unlike `setQuantity()`'s per-quantity
            // CREATE_QUANTITY, which always carries both. Mirrors the
            // CREATE_PROPERTY_SET handling below. Without this branch the
            // `psetName && propName` check above is false and the record
            // matched this `case` with nothing done — never falling through to
            // the "unhandled mutation type" warning either — so a freshly
            // created quantity set silently vanished on
            // exportMutations()/importMutations() round trip.
            this.createQuantitySet(
              mutation.entityId,
              mutation.psetName,
              mutation.newValue as unknown as Array<{ name: string; value: number; quantityType: QuantityType; unit?: string }>,
            );
          }
          break;

        case 'UPDATE_POSITIONAL_ATTRIBUTE': {
          // attributeName is `@<index>` for positional mutations.
          const attr = mutation.attributeName ?? '';
          if (!attr.startsWith('@')) break;
          const index = Number(attr.slice(1));
          if (!Number.isInteger(index) || index < 0) break;
          if (mutation.newValue === undefined) break;
          this.setPositionalAttribute(
            mutation.entityId,
            index,
            mutation.newValue as IfcAttributeValue,
          );
          break;
        }

        case 'UPDATE_ENTITY_TYPE': {
          const newType = mutation.entityType ?? (typeof mutation.newValue === 'string' ? mutation.newValue : undefined);
          if (!newType) break;
          this.setEntityType(
            mutation.entityId,
            newType,
            mutation.predefinedType ?? null,
            mutation.oldValue == null ? undefined : String(mutation.oldValue),
          );
          break;
        }

        case 'UPDATE_ATTRIBUTE':
          if (mutation.attributeName && mutation.newValue !== undefined && mutation.newValue !== null) {
            this.setAttribute(
              mutation.entityId,
              mutation.attributeName,
              String(mutation.newValue),
              mutation.oldValue == null ? undefined : String(mutation.oldValue),
            );
          }
          break;

        case 'CREATE_PROPERTY_SET':
          if (mutation.psetName && Array.isArray(mutation.newValue)) {
            // newValue is the original properties array (see createPropertySet,
            // where newValue = properties: Array<{ name; value; type?; unit? }>).
            this.createPropertySet(
              mutation.entityId,
              mutation.psetName,
              mutation.newValue as unknown as Array<{ name: string; value: PropertyValue; type?: PropertyValueType; unit?: string }>,
            );
          }
          break;

        case 'CREATE_ENTITY': {
          // Replay creates rely on the importer providing the entity body
          // via `restoreNewEntity` separately. The history record alone
          // doesn't carry the type+attributes payload — applying a bare
          // CREATE_ENTITY would lose the entity. We log and skip rather
          // than silently dropping it, so callers see they need to
          // restore the payload through the dedicated path. Unless the
          // caller already restored it, every other mutation recorded
          // against this id in this batch is dropped too (see the guard
          // above this switch) — otherwise the entity is gone but its edits
          // survive as an orphan. (skippedCreateIds was already fully
          // populated in pass 1, above.)
          // eslint-disable-next-line no-console
          console.warn(
            `applyMutations: CREATE_ENTITY for #${mutation.entityId} requires a NewEntity payload — ` +
              `restore via restoreNewEntity(). Skipping the record; dependent mutations recorded against ` +
              `#${mutation.entityId} are dropped too unless the entity was restored before this call.`,
          );
          break;
        }

        case 'DELETE_ENTITY':
          this.deleteEntity(mutation.entityId);
          break;

        default:
          // Surface unhandled mutation types instead of silently dropping
          // them, so future gaps in this switch are visible.
          // eslint-disable-next-line no-console
          console.warn(
            `applyMutations: unhandled mutation type '${mutation.type}' for #${mutation.entityId} — skipped`,
          );
          break;
      }
    }
  }

  /**
   * Export mutations as JSON. Includes every record in `mutationHistory`,
   * including `CREATE_ENTITY` — but see `importMutations` for why replaying
   * that record on another view does not reconstruct the entity.
   */
  exportMutations(): string {
    return JSON.stringify({
      modelId: this.modelId,
      mutations: this.mutationHistory,
      exportedAt: Date.now(),
    }, null, 2);
  }

  /**
   * Import mutations from JSON produced by `exportMutations`.
   *
   * **Not a full inverse of `exportMutations`.** A `CREATE_ENTITY` record
   * carries only the expressId in the history — not the entity's type and
   * attributes — so `importMutations` cannot rebuild the entity from the
   * record alone: it logs a `console.warn` and skips the record, and drops
   * every other mutation recorded against that same entity id in the same
   * batch too (so the round trip is lossy — entity and edits both dropped —
   * rather than leaving an orphaned property/attribute/quantity keyed to an
   * id that was never created on the receiving view).
   *
   * To carry an overlay-created entity across, call `restoreNewEntity()`
   * with its `NewEntity` payload (from `getNewEntity`/`getNewEntities` on
   * the source view) **before** calling `importMutations`. Once the id is
   * live in `newEntities`, its dependent mutations replay normally — only
   * the `console.warn` for the (now redundant) `CREATE_ENTITY` record still
   * fires.
   */
  importMutations(json: string): void {
    const data = JSON.parse(json);
    if (data.mutations && Array.isArray(data.mutations)) {
      this.applyMutations(data.mutations);
    }
  }
}
