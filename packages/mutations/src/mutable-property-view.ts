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
import type { IfcAttributeValue, PropertyValue, PropertyMutation, QuantityMutation, AttributeMutation, Mutation, NewEntity } from './types.js';
import { propertyKey, quantityKey, attributeKey, generateMutationId } from './types.js';

/**
 * Function type for on-demand property extraction
 * Allows globalId to be optional to match extractPropertiesOnDemand return type
 */
export type PropertyExtractor = (entityId: number) => Array<{
  name: string;
  globalId?: string;
  properties: Array<{ name: string; type: number; value: unknown }>;
}>;

/**
 * Function type for on-demand quantity extraction
 */
export type QuantityExtractor = (entityId: number) => QuantitySet[];

export class MutablePropertyView {
  private baseTable: PropertyTable | null;
  private onDemandExtractor: PropertyExtractor | null = null;
  private quantityExtractor: QuantityExtractor | null = null;
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
  private deletedPsets: Set<string> = new Set(); // `${entityId}:${psetName}`
  private deletedQsets: Set<string> = new Set(); // `${entityId}:${qsetName}`
  private newPsets: Map<number, Map<string, PropertySet>> = new Map(); // entityId -> psetName -> PropertySet
  private newQsets: Map<number, Map<string, QuantitySet>> = new Map(); // entityId -> qsetName -> QuantitySet
  private attributeMutations: Map<string, AttributeMutation> = new Map(); // `${entityId}:attr:${attrName}`
  private positionalAttrMutations: Map<number, Map<number, IfcAttributeValue>> = new Map(); // entityId -> argIndex -> value
  private newEntities: Map<number, NewEntity> = new Map();
  private tombstones: Set<number> = new Set();
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
      type: oldValue === null ? 'CREATE_PROPERTY' : 'UPDATE_PROPERTY',
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

    if (oldValue === null) {
      return null; // Property doesn't exist
    }

    this.setPropertyMutation(entityId, key, { operation: 'DELETE' });

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
    this.deletedPsets.add(`${entityId}:${psetName}`);

    // Also remove from new psets if it was created in this session
    const entityPsets = this.newPsets.get(entityId);
    if (entityPsets) {
      entityPsets.delete(psetName);
    }

    // Mark all properties as deleted
    const existingPsets = this.getBasePropertiesForEntity(entityId);
    const pset = existingPsets.find(p => p.name === psetName);
    if (pset) {
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

    // Get old value for undo and to determine CREATE vs UPDATE
    const existingMutation = this.quantityMutations.get(key);
    const oldValue = existingMutation?.value ?? null;
    const isUpdate = existingMutation != null || qsetExistsInBase;

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
    };

    if (!skipHistory) {
      this.mutationHistory.push(mutation);
    }
    return mutation;
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

    this.attributeMutations.set(key, {
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
   * Mark an entity for deletion. Existing entities are tombstoned; new
   * entities (from `createEntity`) are simply forgotten. Returns false if
   * the id is unknown to this view.
   */
  deleteEntity(expressId: number): boolean {
    if (this.newEntities.has(expressId)) {
      this.newEntities.delete(expressId);
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
    // Without this the next createEntity() can hand out the same id and
    // overwrite the restored entity.
    if (entity.expressId > this.nextAllocatedId) {
      this.nextAllocatedId = entity.expressId;
    }
  }

  getTombstones(): Set<number> {
    return new Set(this.tombstones);
  }

  /**
   * Get mutated attributes for an entity.
   * Returns only attributes that have been added/modified via mutations.
   */
  getAttributeMutationsForEntity(entityId: number): Array<{ name: string; value: string }> {
    const result: Array<{ name: string; value: string }> = [];
    for (const [key, mutation] of this.attributeMutations) {
      if (key.startsWith(`${entityId}:attr:`)) {
        result.push({ name: mutation.attribute, value: mutation.value });
      }
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
          }
        }
      }
    } else {
      // Remove entire quantity set
      const entityQsets = this.newQsets.get(entityId);
      if (entityQsets) {
        entityQsets.delete(qsetName);
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
    const key = attributeKey(entityId, attrName);
    this.attributeMutations.delete(key);
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
   * Check if an entity has any mutations
   */
  hasChanges(entityId?: number): boolean {
    if (entityId !== undefined) {
      return this.mutationHistory.some(m => m.entityId === entityId);
    }
    return this.mutationHistory.length > 0;
  }

  /**
   * Get count of modified entities
   */
  getModifiedEntityCount(): number {
    const entities = new Set<number>();
    for (const mutation of this.mutationHistory) {
      entities.add(mutation.entityId);
    }
    return entities.size;
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
    this.deletedPsets.clear();
    this.deletedQsets.clear();
    this.newPsets.clear();
    this.newQsets.clear();
    this.positionalAttrMutations.clear();
    this.newEntities.clear();
    this.tombstones.clear();
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
    const skippedCreateIds = new Set<number>();
    for (const mutation of mutations) {
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

        case 'CREATE_QUANTITY':
        case 'UPDATE_QUANTITY':
          if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
            this.setQuantity(
              mutation.entityId,
              mutation.psetName,
              mutation.propName,
              Number(mutation.newValue),
              QuantityType.Count,
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

        case 'CREATE_ENTITY': {
          // Replay creates rely on the importer providing the entity body
          // via `restoreNewEntity` separately. The history record alone
          // doesn't carry the type+attributes payload — applying a bare
          // CREATE_ENTITY would lose the entity. We log and skip rather
          // than silently dropping it, so callers see they need to
          // restore the payload through the dedicated path.
          skippedCreateIds.add(mutation.entityId);
          // eslint-disable-next-line no-console
          console.warn(
            `applyMutations: CREATE_ENTITY for #${mutation.entityId} requires a NewEntity payload — restore via restoreNewEntity()`,
          );
          break;
        }

        case 'DELETE_ENTITY':
          if (skippedCreateIds.has(mutation.entityId)) break;
          this.deleteEntity(mutation.entityId);
          break;
      }
    }
  }

  /**
   * Export mutations as JSON
   */
  exportMutations(): string {
    return JSON.stringify({
      modelId: this.modelId,
      mutations: this.mutationHistory,
      exportedAt: Date.now(),
    }, null, 2);
  }

  /**
   * Import mutations from JSON
   */
  importMutations(json: string): void {
    const data = JSON.parse(json);
    if (data.mutations && Array.isArray(data.mutations)) {
      this.applyMutations(data.mutations);
    }
  }
}
