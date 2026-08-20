/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Columnar property table - efficient storage and querying
 */

import type { PropertySet, PropertyValue } from '@ifc-lite/parser';

export class PropertyTable {
  private propertySets: Map<number, PropertySet>;
  private entityPropertyMap: Map<number, number[]>; // entityId -> [propertySetId, ...]

  constructor() {
    this.propertySets = new Map();
    this.entityPropertyMap = new Map();
  }

  /**
   * Add property set
   */
  addPropertySet(id: number, propertySet: PropertySet): void {
    this.propertySets.set(id, propertySet);
  }

  /**
   * Associate property set with entity
   */
  associatePropertySet(entityId: number, propertySetId: number): void {
    let sets = this.entityPropertyMap.get(entityId);
    if (!sets) {
      sets = [];
      this.entityPropertyMap.set(entityId, sets);
    }
    sets.push(propertySetId);
  }

  /**
   * Get property value for entity. An entity can carry two same-named
   * property sets (two IfcRelDefinesByProperties pointing at distinct
   * IfcPropertySets, same as `findEntities` below handles) — keep scanning
   * subsequent same-named sets when an earlier one doesn't have the
   * property, rather than returning null on the first name match.
   */
  getProperty(entityId: number, propertySetName: string, propertyName: string): PropertyValue | null {
    const propertySetIds = this.entityPropertyMap.get(entityId);
    if (!propertySetIds) return null;

    for (const setId of propertySetIds) {
      const pset = this.propertySets.get(setId);
      if (pset && pset.name === propertySetName) {
        const value = pset.properties.get(propertyName);
        if (value) return value;
      }
    }

    return null;
  }

  /**
   * Get all properties for entity
   */
  getProperties(entityId: number): Map<string, PropertySet> {
    const result = new Map<string, PropertySet>();
    const propertySetIds = this.entityPropertyMap.get(entityId);
    if (!propertySetIds) return result;

    for (const setId of propertySetIds) {
      const pset = this.propertySets.get(setId);
      if (pset) {
        result.set(pset.name, pset);
      }
    }

    return result;
  }

  /**
   * Find entities with property matching value
   */
  findEntities(propertySetName: string, propertyName: string, value: any): number[] {
    const results: number[] = [];

    for (const [entityId, propertySetIds] of this.entityPropertyMap) {
      for (const setId of propertySetIds) {
        const pset = this.propertySets.get(setId);
        if (pset && pset.name === propertySetName) {
          const prop = pset.properties.get(propertyName);
          if (prop && prop.value === value) {
            results.push(entityId);
            break;
          }
        }
      }
    }

    return results;
  }
}
