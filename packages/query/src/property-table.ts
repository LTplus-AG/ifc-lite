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
   * Get all properties for entity, one entry per distinct pset NAME.
   *
   * An entity can carry two same-named property sets (two
   * `IfcRelDefinesByProperties` pointing at distinct `IfcPropertySet`s — the
   * same shape `getProperty`, above, scans through). Keying the result
   * `Map` by name alone would let the later same-named set overwrite the
   * earlier one, silently dropping every property that lived only in the
   * set that got overwritten. Merge same-named sets' properties instead —
   * earlier-set values win on a key collision, matching `getProperty`'s own
   * first-match-wins order above.
   */
  getProperties(entityId: number): Map<string, PropertySet> {
    const result = new Map<string, PropertySet>();
    const propertySetIds = this.entityPropertyMap.get(entityId);
    if (!propertySetIds) return result;

    for (const setId of propertySetIds) {
      const pset = this.propertySets.get(setId);
      if (!pset) continue;
      const existing = result.get(pset.name);
      if (!existing) {
        result.set(pset.name, pset);
        continue;
      }
      if (existing === pset) continue; // same pset shared across entities
      const merged = new Map(pset.properties);
      for (const [key, value] of existing.properties) merged.set(key, value); // earlier wins
      result.set(pset.name, { name: pset.name, properties: merged });
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
