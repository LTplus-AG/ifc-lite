/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Query result entity - lazy-loaded entity data
 */

import type { IfcStoreBase as IfcDataStore } from '@ifc-lite/data';
import type { PropertySet, QuantitySet, PropertyValue } from '@ifc-lite/data';
import type { MeshData } from '@ifc-lite/geometry';
import { EntityNode } from './entity-node.js';

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
    return this.store.getProperties(this.expressId);
  }

  get quantities(): QuantitySet[] {
    if (this._quantities !== undefined) {
      return this._quantities;
    }
    return this.store.getQuantities(this.expressId);
  }

  get geometry(): MeshData | null {
    if (this._geometry !== undefined) {
      return this._geometry;
    }
    // Geometry is not stored in IfcDataStore yet, return null for now
    return null;
  }

  getProperty(psetName: string, propName: string): PropertyValue | null {
    for (const pset of this.store.getProperties(this.expressId)) {
      if (pset.name !== psetName) continue;
      for (const p of pset.properties) {
        if (p.name === propName) return p.value;
      }
    }
    return null;
  }

  loadProperties(): void {
    if (this._properties === undefined) {
      this._properties = this.store.getProperties(this.expressId);
    }
  }

  loadQuantities(): void {
    if (this._quantities === undefined) {
      this._quantities = this.store.getQuantities(this.expressId);
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
