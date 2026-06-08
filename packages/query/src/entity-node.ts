/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity node for graph traversal
 */

import type { IfcStoreBase as IfcDataStore, IfcEntity, IfcAttributeValue, PropertySet, QuantitySet, PropertyValue } from '@ifc-lite/data';
import { getRawNamedAttributes, extractRootAttributesFromEntity } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';

function coerceRaw(raw: IfcAttributeValue): string | number | boolean | null {
  if (typeof raw === 'string') {
    if (raw === '.U.' || raw === '.X.') return null;
    if (raw === '.T.') return true;
    if (raw === '.F.') return false;
    return raw.startsWith('.') && raw.endsWith('.') ? raw.slice(1, -1) : raw;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (Array.isArray(raw) && raw.length === 2) {
    const tag = String(raw[0]).toUpperCase();
    const inner = raw[1];
    if (tag.includes('BOOLEAN')) return inner === '.T.' || inner === true;
    if (tag.includes('LOGICAL')) {
      if (inner === '.U.' || inner === '.X.') return null;
      return inner === '.T.' || inner === true;
    }
    if (typeof inner === 'number' || typeof inner === 'boolean') return inner;
    if (typeof inner === 'string' && inner) {
      return inner.startsWith('.') && inner.endsWith('.') ? inner.slice(1, -1) : inner;
    }
  }
  return null;
}

export function extractAllEntityAttributesFromEntity(
  entity: IfcEntity
): Array<{ name: string; value: string | number | boolean }> {
  const result: Array<{ name: string; value: string | number | boolean }> = [];
  for (const { name, raw } of getRawNamedAttributes(entity)) {
    const value = coerceRaw(raw);
    if (value !== null) result.push({ name, value });
  }
  return result;
}

export class EntityNode {
  private store: IfcDataStore;
  readonly expressId: number;
  private _cachedAttributes: { globalId: string; name: string; description: string; objectType: string; tag: string } | null = null;

  constructor(store: IfcDataStore, expressId: number) {
    this.store = store;
    this.expressId = expressId;
  }

  /**
   * Get on-demand extracted attributes (cached for performance)
   * Only extracts if stored values are empty and source buffer is available
   */
  private getOnDemandAttributes(): { globalId: string; name: string; description: string; objectType: string; tag: string } {
    if (this._cachedAttributes) return this._cachedAttributes;
    const entity = this.store.getEntity(this.expressId);
    // Map by schema attribute name, not fixed index: `attrs[7]` is Tag only for
    // IfcElement — for an IfcSite it is LongName, and for an IfcMaterial
    // `attrs[0]` is Name rather than GlobalId. See extractRootAttributesFromEntity.
    const result = entity
      ? extractRootAttributesFromEntity(entity)
      : { globalId: '', name: '', description: '', objectType: '', tag: '' };
    this._cachedAttributes = result;
    return result;
  }

  get globalId(): string {
    // Try stored value first (fast path for spatial entities)
    const stored = this.store.entities.getGlobalId(this.expressId);
    if (stored) return stored;
    // Fall back to on-demand extraction for other entities
    return this.getOnDemandAttributes().globalId;
  }

  get name(): string {
    // Try stored value first (fast path for spatial entities)
    const stored = this.store.entities.getName(this.expressId);
    if (stored) return stored;
    // Fall back to on-demand extraction for other entities
    return this.getOnDemandAttributes().name;
  }

  get description(): string {
    // Try stored value first
    const stored = this.store.entities.getDescription(this.expressId);
    if (stored) return stored;
    // Fall back to on-demand extraction
    return this.getOnDemandAttributes().description;
  }

  get objectType(): string {
    // Try stored value first
    const stored = this.store.entities.getObjectType(this.expressId);
    if (stored) return stored;
    // Fall back to on-demand extraction
    return this.getOnDemandAttributes().objectType;
  }

  get tag(): string {
    // Tag is only stored on-demand (not in entity table)
    return this.getOnDemandAttributes().tag;
  }

  /**
   * Get all named string/enum attributes for this entity.
   * Uses the IFC schema to determine attribute names per entity type.
   * Skips GlobalId (shown separately), OwnerHistory, and geometry references.
   */
  allAttributes(): Array<{ name: string; value: string | number | boolean }> {
    const entity = this.store.getEntity(this.expressId);
    if (entity) {
      return extractAllEntityAttributesFromEntity(entity);
    }

    // Fallback: return individually known attributes
    const attrs: Array<{ name: string; value: string | number | boolean }> = [];
    if (this.name) attrs.push({ name: 'Name', value: this.name });
    if (this.description) attrs.push({ name: 'Description', value: this.description });
    if (this.objectType) attrs.push({ name: 'ObjectType', value: this.objectType });
    if (this.tag) attrs.push({ name: 'Tag', value: this.tag });
    return attrs;
  }

  get type(): string {
    return this.store.entities.getTypeName(this.expressId);
  }

  // Spatial containment
  contains(): EntityNode[] {
    return this.getRelated(RelationshipType.ContainsElements, 'forward');
  }
  
  containedIn(): EntityNode | null {
    const nodes = this.getRelated(RelationshipType.ContainsElements, 'inverse');
    return nodes[0] ?? null;
  }
  
  // Aggregation
  decomposes(): EntityNode[] {
    return this.getRelated(RelationshipType.Aggregates, 'forward');
  }
  
  decomposedBy(): EntityNode | null {
    const nodes = this.getRelated(RelationshipType.Aggregates, 'inverse');
    return nodes[0] ?? null;
  }
  
  // Types
  definingType(): EntityNode | null {
    const nodes = this.getRelated(RelationshipType.DefinesByType, 'forward');
    return nodes[0] ?? null;
  }
  
  instances(): EntityNode[] {
    return this.getRelated(RelationshipType.DefinesByType, 'inverse');
  }
  
  // Openings
  voids(): EntityNode[] {
    return this.getRelated(RelationshipType.VoidsElement, 'forward');
  }
  
  filledBy(): EntityNode[] {
    return this.getRelated(RelationshipType.FillsElement, 'inverse');
  }

  // Multi-hop traversal
  traverse(relType: RelationshipType, depth: number, direction: 'forward' | 'inverse' = 'forward'): EntityNode[] {
    // Track the minimum depth at which each node was reached so a node first
    // discovered via a longer path is re-expanded when later found shallower.
    // Without this, descendants within `depth` along the shorter route are missed.
    const bestDepth = new Map<number, number>();
    const result: EntityNode[] = [];

    const visit = (nodeId: number, currentDepth: number) => {
      if (currentDepth > depth) return;
      const prev = bestDepth.get(nodeId);
      if (prev !== undefined && prev <= currentDepth) return;
      const firstVisit = prev === undefined;
      bestDepth.set(nodeId, currentDepth);
      // Guard so each node is added to the result only once, even when re-expanded.
      if (firstVisit && nodeId !== this.expressId) {
        result.push(new EntityNode(this.store, nodeId));
      }

      const edges = direction === 'forward'
        ? this.store.relationships.forward.getEdges(nodeId, relType)
        : this.store.relationships.inverse.getEdges(nodeId, relType);
      for (const edge of edges) {
        visit(edge.target, currentDepth + 1);
      }
    };

    visit(this.expressId, 0);
    return result;
  }

  // Spatial shortcuts
  building(): EntityNode | null {
    let current: EntityNode | null = this;
    const visited = new Set<number>();
    
    while (current && !visited.has(current.expressId)) {
      visited.add(current.expressId);
      if (current.type === 'IfcBuilding') return current;
      current = current.containedIn() ?? current.decomposedBy();
    }
    return null;
  }
  
  storey(): EntityNode | null {
    let current: EntityNode | null = this;
    const visited = new Set<number>();
    
    while (current && !visited.has(current.expressId)) {
      visited.add(current.expressId);
      if (current.type === 'IfcBuildingStorey') return current;
      current = current.containedIn() ?? current.decomposedBy();
    }
    return null;
  }

  // Data access - delegates to IfcDataStore interface methods
  properties(): PropertySet[] {
    return this.store.getProperties(this.expressId);
  }

  property(psetName: string, propName: string): PropertyValue | null {
    const props = this.store.getProperties(this.expressId);
    const pset = props.find(p => p.name === psetName);
    return pset?.properties.find(p => p.name === propName)?.value ?? null;
  }

  quantities(): QuantitySet[] {
    return this.store.getQuantities(this.expressId);
  }

  quantity(qsetName: string, quantityName: string): number | null {
    const qsets = this.store.getQuantities(this.expressId);
    const qset = qsets.find(q => q.name === qsetName);
    return qset?.quantities.find(q => q.name === quantityName)?.value ?? null;
  }

  private getRelated(relType: RelationshipType, direction: 'forward' | 'inverse'): EntityNode[] {
    const targets = this.store.relationships.getRelated(this.expressId, relType, direction);
    return targets.map((id: number) => new EntityNode(this.store, id));
  }
}
