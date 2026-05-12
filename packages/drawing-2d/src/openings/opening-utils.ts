/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Utility functions for opening handling
 */

import type {
  OpeningRelationships,
  OpeningInfo,
  VoidRelationship,
  FillRelationship,
  EntityMetadata,
} from '../types.js';
import { OpeningRelationshipBuilder } from './opening-relationship-builder.js';

/**
 * Build opening relationships from void and fill relationship arrays
 */
export function buildOpeningRelationships(
  voids: VoidRelationship[],
  fills: FillRelationship[],
  entityMetadata?: Map<number, EntityMetadata>,
  modelIndex: number = 0
): OpeningRelationships {
  return new OpeningRelationshipBuilder(entityMetadata)
    .addVoidRelationships(voids)
    .addFillRelationships(fills)
    .build(modelIndex);
}

/**
 * Get all opening IDs for a host element (wall, slab, etc.)
 */
export function getOpeningsForHost(
  relationships: OpeningRelationships,
  hostId: number
): number[] {
  return relationships.voidedBy.get(hostId) ?? [];
}

/**
 * Get the filling element (door/window) for an opening
 */
export function getFillingElement(
  relationships: OpeningRelationships,
  openingId: number
): number | undefined {
  return relationships.filledBy.get(openingId);
}

/**
 * Get opening info by entity ID (works for both opening and filling elements)
 */
export function getOpeningInfo(
  relationships: OpeningRelationships,
  entityId: number
): OpeningInfo | undefined {
  return relationships.openingInfo.get(entityId);
}

/**
 * Check if an IFC type represents an opening element
 */
export function isOpeningElement(ifcType: string): boolean {
  const upper = ifcType.toUpperCase();
  return (
    upper === 'IFCOPENINGELEMENT' ||
    upper === 'IFCOPENINGSTANDARDCASE' ||
    upper === 'IFCVOIDINGELEMENT'
  );
}

/**
 * Check if an IFC type represents a door or window
 */
export function isDoorOrWindow(ifcType: string): boolean {
  const upper = ifcType.toUpperCase();
  return (
    upper.includes('DOOR') ||
    upper.includes('WINDOW')
  );
}

/**
 * Check if an IFC type is a host element that can have openings
 */
export function isHostElement(ifcType: string): boolean {
  const upper = ifcType.toUpperCase();
  return (
    upper.includes('WALL') ||
    upper.includes('SLAB') ||
    upper.includes('ROOF') ||
    upper.includes('FLOOR')
  );
}

/**
 * Get all host element IDs that have openings
 */
export function getHostsWithOpenings(
  relationships: OpeningRelationships
): number[] {
  return Array.from(relationships.voidedBy.keys());
}

/**
 * Get all door opening infos
 */
export function getDoorOpenings(
  relationships: OpeningRelationships
): OpeningInfo[] {
  const result: OpeningInfo[] = [];
  const seen = new Set<number>();

  for (const [, info] of relationships.openingInfo) {
    if (info.type === 'door' && !seen.has(info.openingId)) {
      result.push(info);
      seen.add(info.openingId);
    }
  }
  return result;
}

/**
 * Get all window opening infos
 */
export function getWindowOpenings(
  relationships: OpeningRelationships
): OpeningInfo[] {
  const result: OpeningInfo[] = [];
  const seen = new Set<number>();

  for (const [, info] of relationships.openingInfo) {
    if (info.type === 'window' && !seen.has(info.openingId)) {
      result.push(info);
      seen.add(info.openingId);
    }
  }
  return result;
}

/**
 * Filter entity IDs to exclude opening elements
 * Useful for filtering meshes before section cutting
 */
export function filterOutOpeningElements(
  entityIds: number[],
  relationships: OpeningRelationships
): number[] {
  const openingIds = new Set<number>();

  // Collect all opening and filling element IDs
  for (const openingIdList of relationships.voidedBy.values()) {
    for (const id of openingIdList) {
      openingIds.add(id);
    }
  }
  for (const fillingId of relationships.filledBy.values()) {
    openingIds.add(fillingId);
  }

  return entityIds.filter((id) => !openingIds.has(id));
}

/**
 * Get the entity IDs that should be included in cut lines (hosts only)
 * Excludes opening elements and their filling elements
 */
export function getHostEntityIds(
  allEntityIds: number[],
  relationships: OpeningRelationships,
  ifcTypes: Map<number, string>
): number[] {
  const result: number[] = [];

  for (const id of allEntityIds) {
    const ifcType = ifcTypes.get(id);
    if (!ifcType) continue;

    // Skip opening elements and doors/windows
    if (isOpeningElement(ifcType) || isDoorOrWindow(ifcType)) {
      continue;
    }

    result.push(id);
  }

  return result;
}
