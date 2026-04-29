/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Index building and type classification for columnar parsing.
 *
 * Pre-computed type sets for O(1) lookups, type-checking predicates,
 * and interface definitions for spatial and entity-by-ID indexes.
 */

import type { EntityRef } from './types.js';
import {
    RelationshipType,
    QuantityType,
} from '@ifc-lite/data';

// SpatialIndex interface - matches BVH from @ifc-lite/spatial
export interface SpatialIndex {
    queryAABB(bounds: { min: [number, number, number]; max: [number, number, number] }): number[];
    raycast(origin: [number, number, number], direction: [number, number, number]): number[];
}

/**
 * Entity-by-ID lookup interface. Supports both Map<number, EntityRef> (legacy)
 * and CompactEntityIndex (memory-optimized typed arrays with LRU cache).
 */
export type EntityByIdIndex = {
    get(expressId: number): EntityRef | undefined;
    has(expressId: number): boolean;
    readonly size: number;
    keys(): IterableIterator<number>;
    values(): IterableIterator<EntityRef>;
    entries(): IterableIterator<[number, EntityRef]>;
    forEach(callback: (value: EntityRef, key: number) => void): void;
    [Symbol.iterator](): IterableIterator<[number, EntityRef]>;
};

// Pre-computed type sets for O(1) lookups
export const GEOMETRY_TYPES = new Set([
    'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCDOOR', 'IFCWINDOW', 'IFCSLAB',
    'IFCCOLUMN', 'IFCBEAM', 'IFCROOF', 'IFCSTAIR', 'IFCSTAIRFLIGHT',
    'IFCRAILING', 'IFCRAMP', 'IFCRAMPFLIGHT', 'IFCPLATE', 'IFCMEMBER',
    'IFCCURTAINWALL', 'IFCFOOTING', 'IFCPILE', 'IFCBUILDINGELEMENTPROXY',
    'IFCFURNISHINGELEMENT', 'IFCFLOWSEGMENT', 'IFCFLOWTERMINAL',
    'IFCFLOWCONTROLLER', 'IFCFLOWFITTING', 'IFCSPACE', 'IFCOPENINGELEMENT',
    'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY',
]);

// IMPORTANT: This set MUST include ALL RelationshipType enum values to prevent semantic loss
// Missing types will be skipped during parsing, causing incomplete relationship graphs
export const RELATIONSHIP_TYPES = new Set([
    'IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCRELAGGREGATES',
    'IFCRELDEFINESBYPROPERTIES', 'IFCRELDEFINESBYTYPE',
    'IFCRELASSOCIATESMATERIAL', 'IFCRELASSOCIATESCLASSIFICATION',
    'IFCRELASSOCIATESDOCUMENT',
    'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT',
    'IFCRELCONNECTSPATHELEMENTS', 'IFCRELCONNECTSELEMENTS',
    'IFCRELCONNECTSSTRUCTURALMEMBER', 'IFCRELCONNECTSWITHREALIZINGELEMENTS',
    'IFCRELSPACEBOUNDARY',
    'IFCRELASSIGNSTOGROUP', 'IFCRELASSIGNSTOPRODUCT',
    'IFCRELREFERENCEDINSPATIALSTRUCTURE',
]);

// Map IFC relationship type strings to RelationshipType enum
// MUST cover ALL RelationshipType enum values (17 types total)
export const REL_TYPE_MAP: Record<string, RelationshipType> = {
    'IFCRELCONTAINEDINSPATIALSTRUCTURE': RelationshipType.ContainsElements,
    'IFCRELAGGREGATES': RelationshipType.Aggregates,
    'IFCRELDEFINESBYPROPERTIES': RelationshipType.DefinesByProperties,
    'IFCRELDEFINESBYTYPE': RelationshipType.DefinesByType,
    'IFCRELASSOCIATESMATERIAL': RelationshipType.AssociatesMaterial,
    'IFCRELASSOCIATESCLASSIFICATION': RelationshipType.AssociatesClassification,
    'IFCRELASSOCIATESDOCUMENT': RelationshipType.AssociatesDocument,
    'IFCRELVOIDSELEMENT': RelationshipType.VoidsElement,
    'IFCRELFILLSELEMENT': RelationshipType.FillsElement,
    'IFCRELCONNECTSPATHELEMENTS': RelationshipType.ConnectsPathElements,
    'IFCRELCONNECTSELEMENTS': RelationshipType.ConnectsElements,
    'IFCRELCONNECTSSTRUCTURALMEMBER': RelationshipType.ConnectsStructuralMember,
    'IFCRELCONNECTSWITHREALIZINGELEMENTS': RelationshipType.ConnectsWithRealizingElements,
    'IFCRELSPACEBOUNDARY': RelationshipType.SpaceBoundary,
    'IFCRELASSIGNSTOGROUP': RelationshipType.AssignsToGroup,
    'IFCRELASSIGNSTOPRODUCT': RelationshipType.AssignsToProduct,
    'IFCRELREFERENCEDINSPATIALSTRUCTURE': RelationshipType.ReferencedInSpatialStructure,
};

export const QUANTITY_TYPE_MAP: Record<string, QuantityType> = {
    'IFCQUANTITYLENGTH': QuantityType.Length,
    'IFCQUANTITYAREA': QuantityType.Area,
    'IFCQUANTITYVOLUME': QuantityType.Volume,
    'IFCQUANTITYCOUNT': QuantityType.Count,
    'IFCQUANTITYWEIGHT': QuantityType.Weight,
    'IFCQUANTITYTIME': QuantityType.Time,
};

// Types needed for spatial hierarchy (small subset)
export const SPATIAL_TYPES = new Set([
    'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE',
    'IFCFACILITY', 'IFCFACILITYPART',
    'IFCBRIDGE', 'IFCBRIDGEPART',
    'IFCROAD', 'IFCROADPART',
    'IFCRAILWAY', 'IFCRAILWAYPART',
    'IFCMARINEFACILITY',
]);

// Relationship types needed for hierarchy and structural relationships
export const HIERARCHY_REL_TYPES = new Set([
    'IFCRELAGGREGATES', 'IFCRELCONTAINEDINSPATIALSTRUCTURE',
    'IFCRELDEFINESBYTYPE',
    // Structural relationships (voids, fills, connections, groups)
    'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT',
    'IFCRELCONNECTSPATHELEMENTS', 'IFCRELCONNECTSELEMENTS',
    'IFCRELCONNECTSSTRUCTURALMEMBER', 'IFCRELCONNECTSWITHREALIZINGELEMENTS',
    'IFCRELSPACEBOUNDARY',
    'IFCRELASSIGNSTOGROUP', 'IFCRELASSIGNSTOPRODUCT',
    'IFCRELREFERENCEDINSPATIALSTRUCTURE',
]);

// Relationship types for on-demand property loading
export const PROPERTY_REL_TYPES = new Set([
    'IFCRELDEFINESBYPROPERTIES',
]);

// Relationship types for on-demand classification/material loading
export const ASSOCIATION_REL_TYPES = new Set([
    'IFCRELASSOCIATESCLASSIFICATION', 'IFCRELASSOCIATESMATERIAL',
    'IFCRELASSOCIATESDOCUMENT',
]);

// Attributes to skip in extractAllEntityAttributes (shown elsewhere or non-displayable)
export const SKIP_DISPLAY_ATTRS = new Set(['GlobalId', 'OwnerHistory', 'ObjectPlacement', 'Representation', 'HasPropertySets', 'RepresentationMaps']);

// Property-related entity types for on-demand extraction
export const PROPERTY_ENTITY_TYPES = new Set([
    'IFCPROPERTYSET', 'IFCELEMENTQUANTITY',
    'IFCPROPERTYSINGLEVALUE', 'IFCPROPERTYENUMERATEDVALUE',
    'IFCPROPERTYBOUNDEDVALUE', 'IFCPROPERTYTABLEVALUE',
    'IFCPROPERTYLISTVALUE', 'IFCPROPERTYREFERENCEVALUE',
    'IFCQUANTITYLENGTH', 'IFCQUANTITYAREA', 'IFCQUANTITYVOLUME',
    'IFCQUANTITYCOUNT', 'IFCQUANTITYWEIGHT', 'IFCQUANTITYTIME',
]);

export const PROPERTY_CONTAINER_TYPES = new Set([
    'IFCPROPERTYSET',
    'IFCELEMENTQUANTITY',
]);

export function isIfcTypeLikeEntity(typeUpper: string): boolean {
    return typeUpper.endsWith('TYPE') || typeUpper.endsWith('STYLE');
}
