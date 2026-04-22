/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Query result entity - lazy-loaded entity data
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import type { PropertySet, QuantitySet, Property, Quantity, PropertyValue } from '@ifc-lite/data';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import type { MeshData } from '@ifc-lite/geometry';
import { EntityNode } from './entity-node.js';

function hasOnDemandProperties(store: IfcDataStore): boolean {
  return !!store.onDemandPropertyMap && !!store.source && store.source.length > 0;
}

function hasOnDemandQuantities(store: IfcDataStore): boolean {
  return !!store.onDemandQuantityMap && !!store.source && store.source.length > 0;
}

function loadPropertiesFromStore(store: IfcDataStore, expressId: number): PropertySet[] {
  const preParsed = store.properties.getForEntity(expressId);
  if (preParsed.length > 0 || !hasOnDemandProperties(store)) {
    return preParsed;
  }
  const raw = extractPropertiesOnDemand(store, expressId);
  return raw.map((pset): PropertySet => ({
    name: pset.name,
    globalId: pset.globalId ?? '',
    properties: pset.properties.map((p): Property => ({
      name: p.name,
      type: p.type as PropertyValueType,
      value: p.value as PropertyValue,
    })),
  }));
}

function loadQuantitiesFromStore(store: IfcDataStore, expressId: number): QuantitySet[] {
  const preParsed = store.quantities ? store.quantities.getForEntity(expressId) : [];
  if (preParsed.length > 0 || !hasOnDemandQuantities(store)) {
    return preParsed;
  }
  const raw = extractQuantitiesOnDemand(store, expressId);
  return raw.map((qset): QuantitySet => ({
    name: qset.name,
    quantities: qset.quantities.map((q): Quantity => ({
      name: q.name,
      type: q.type as QuantityType,
      value: q.value,
    })),
  }));
}

export class QueryResultEntity {
  private store: IfcDataStore;
  readonly expressId: number;

  // Cached data (loaded eagerly when includeFlags are set)
  private _properties?: PropertySet[];
  private _quantities?: QuantitySet[];
  private _geometry?: MeshData | null;

  constructor(store: IfcDataStore, expressId: number, _includeFlags?: { geometry?: boolean; properties?: boolean; quantities?: boolean }) {
    this.store = store;
    this.expressId = expressId;
  }

  get globalId(): string {
    return this.store.entities.getGlobalId(this.expressId);
  }

  get name(): string {
    return this.store.entities.getName(this.expressId);
  }

  get type(): string {
    return this.store.entities.getTypeName(this.expressId);
  }

  get properties(): PropertySet[] {
    if (this._properties !== undefined) {
      return this._properties;
    }
    return loadPropertiesFromStore(this.store, this.expressId);
  }

  get quantities(): QuantitySet[] {
    if (this._quantities !== undefined) {
      return this._quantities;
    }
    return loadQuantitiesFromStore(this.store, this.expressId);
  }

  get geometry(): MeshData | null {
    if (this._geometry !== undefined) {
      return this._geometry;
    }
    // Geometry is not stored in IfcDataStore yet, return null for now
    return null;
  }

  getProperty(psetName: string, propName: string): PropertyValue | null {
    const direct = this.store.properties.getPropertyValue(this.expressId, psetName, propName);
    if (direct !== null) return direct;
    if (!hasOnDemandProperties(this.store)) return null;
    for (const pset of loadPropertiesFromStore(this.store, this.expressId)) {
      if (pset.name !== psetName) continue;
      for (const p of pset.properties) {
        if (p.name === propName) return p.value;
      }
    }
    return null;
  }

  loadProperties(): void {
    if (this._properties === undefined) {
      this._properties = loadPropertiesFromStore(this.store, this.expressId);
    }
  }

  loadQuantities(): void {
    if (this._quantities === undefined) {
      this._quantities = loadQuantitiesFromStore(this.store, this.expressId);
    }
  }
  
  loadGeometry(): void {
    if (this._geometry === undefined) {
      // Geometry is not stored in IfcDataStore yet, set to null
      // In the future, this could access a geometry store
      this._geometry = null;
    }
  }
  
  asNode(): EntityNode {
    return new EntityNode(this.store, this.expressId);
  }
  
  toJSON(): object {
    return {
      expressId: this.expressId,
      globalId: this.globalId,
      name: this.name,
      type: this.type,
      properties: this.properties,
      quantities: this.quantities.length > 0 ? this.quantities : undefined,
    };
  }
}
