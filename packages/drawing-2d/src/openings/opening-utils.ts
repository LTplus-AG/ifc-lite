/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Utility functions for opening handling
 */

import type {
  OpeningRelationships,
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

