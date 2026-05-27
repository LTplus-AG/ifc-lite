/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property extractor - extracts PropertySets and their values
 *
 * @deprecated Legacy eager `ParseResult` helper. Use
 * `extractPropertiesOnDemand(store, expressId)` with `parseColumnar()`.
 */

import type { IfcEntity, PropertySet, PropertyValue } from './types.js';

export class PropertyExtractor {
  private entities: Map<number, IfcEntity>;

  constructor(entities: Map<number, IfcEntity>) {
    this.entities = entities;
  }

  /**
   * Extract all PropertySets from entities (async version with yields)
   */
  async extractPropertySetsAsync(): Promise<Map<number, PropertySet>> {
    const propertySets = new Map<number, PropertySet>();
    let processed = 0;

    for (const [id, entity] of this.entities) {
      if (entity.type.toUpperCase() === 'IFCPROPERTYSET') {
        const pset = this.extractPropertySet(entity);
        if (pset) {
          propertySets.set(id, pset);
        }
      }

      processed++;
      // Yield to event loop every 2000 entities to prevent blocking
      if (processed % 2000 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return propertySets;
  }

  /**
   * Extract all PropertySets from entities (sync version for backward compatibility)
   */
  extractPropertySets(): Map<number, PropertySet> {
    const propertySets = new Map<number, PropertySet>();

    for (const [id, entity] of this.entities) {
      // IFC entity types may be uppercase (IFCPROPERTYSET) or mixed case (IfcPropertySet)
      if (entity.type.toUpperCase() === 'IFCPROPERTYSET') {
        const pset = this.extractPropertySet(entity);
        if (pset) {
          propertySets.set(id, pset);
        }
      }
    }

    return propertySets;
  }

  /**
   * Extract PropertySet from entity
   */
  private extractPropertySet(entity: IfcEntity): PropertySet | null {
    try {
      // IfcPropertySet structure: (GlobalId, OwnerHistory, Name, Description, HasProperties)
      // Attributes: [0]=GlobalId, [1]=OwnerHistory, [2]=Name, [3]=Description, [4]=HasProperties
      const name = this.getAttributeValue(entity, 2) as string;
      if (!name) return null;

      const hasProperties = this.getAttributeValue(entity, 4);
      const properties = new Map<string, PropertyValue>();

      // HasProperties is a list of references to IfcProperty
      if (Array.isArray(hasProperties)) {
        for (const propRef of hasProperties) {
          if (typeof propRef === 'number') {
            const propEntity = this.entities.get(propRef);
            if (propEntity) {
              const prop = this.extractProperty(propEntity);
              if (prop) {
                properties.set(prop.name, prop.value);
              }
            }
          }
        }
      }

      return { name, properties };
    } catch (error) {
      console.warn(`Failed to extract PropertySet #${entity.expressId}:`, error);
      return null;
    }
  }

  /**
   * Extract property from IfcProperty entity
   */
  private extractProperty(entity: IfcEntity): { name: string; value: PropertyValue } | null {
    try {
      // IfcPropertySingleValue structure: (Name, Description, NominalValue, Unit)
      const name = this.getAttributeValue(entity, 0) as string;
      if (!name) return null;

      const nominalValue = this.getAttributeValue(entity, 2);
      const value = this.parsePropertyValue(nominalValue);

      return { name, value };
    } catch (error) {
      console.warn(`Failed to extract property #${entity.expressId}:`, error);
      return null;
    }
  }

  private parsePropertyValue(value: any): PropertyValue {
    if (value === null || value === undefined) {
      return { type: 'null', value: null };
    }

    if (typeof value === 'number') {
      return { type: 'number', value };
    }

    if (typeof value === 'boolean') {
      return { type: 'boolean', value };
    }

    if (typeof value === 'string') {
      return { type: 'string', value };
    }

    if (typeof value === 'number' && value < 0) {
      // Negative numbers might be references in some contexts
      return { type: 'reference', value };
    }

    return { type: 'string', value: String(value) };
  }

  private getAttributeValue(entity: IfcEntity, index: number): any {
    if (index < 0 || index >= entity.attributes.length) {
      return null;
    }
    return entity.attributes[index];
  }
}
