/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Builds opening relationship data from IFC void/fill relationships
 */

import type {
  OpeningRelationships,
  OpeningInfo,
  VoidRelationship,
  FillRelationship,
  EntityMetadata,
  DoorOperationType,
  WindowPartitioningType,
  Vec3,
} from '../types.js';

/**
 * Builder for creating OpeningRelationships from raw relationship data
 */
export class OpeningRelationshipBuilder {
  private voidedBy = new Map<number, number[]>();
  private filledBy = new Map<number, number>();
  private openingInfo = new Map<number, OpeningInfo>();
  private entityMetadata: Map<number, EntityMetadata>;

  constructor(entityMetadata?: Map<number, EntityMetadata>) {
    this.entityMetadata = entityMetadata ?? new Map();
  }

  /**
   * Add void relationships (IfcRelVoidsElement)
   * hostId is the wall/slab, openingId is the IfcOpeningElement
   */
  addVoidRelationships(voids: VoidRelationship[]): this {
    for (const { hostId, openingId } of voids) {
      const existing = this.voidedBy.get(hostId);
      if (existing) {
        existing.push(openingId);
      } else {
        this.voidedBy.set(hostId, [openingId]);
      }
    }
    return this;
  }

  /**
   * Add fill relationships (IfcRelFillsElement)
   * openingId is the IfcOpeningElement, elementId is the door/window
   */
  addFillRelationships(fills: FillRelationship[]): this {
    for (const { openingId, elementId } of fills) {
      this.filledBy.set(openingId, elementId);
    }
    return this;
  }

  /**
   * Build complete OpeningInfo for all openings
   */
  build(modelIndex: number = 0): OpeningRelationships {
    // Build OpeningInfo for each opening
    for (const [hostId, openingIds] of this.voidedBy) {
      for (const openingId of openingIds) {
        const fillingElementId = this.filledBy.get(openingId);
        const openingMeta = this.entityMetadata.get(openingId);
        const fillingMeta = fillingElementId
          ? this.entityMetadata.get(fillingElementId)
          : undefined;

        // Determine opening type from filling element
        const type = this.determineOpeningType(fillingMeta?.ifcType);

        // Get bounds from metadata or use defaults
        const bounds = openingMeta?.bounds ?? fillingMeta?.bounds ?? {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1, y: 1, z: 2.1 },
        };

        const info: OpeningInfo = {
          type,
          openingId,
          hostElementId: hostId,
          fillingElementId,
          fillingType: fillingMeta?.ifcType,
          width: bounds.max.x - bounds.min.x,
          height: bounds.max.z - bounds.min.z,
          bounds3D: bounds,
          modelIndex,
        };

        // Add door operation type if available
        if (type === 'door' && fillingMeta) {
          info.doorOperation = this.extractDoorOperation(
            fillingMeta.properties ?? {},
            fillingMeta.typeOperationType
          );
        }

        // Add window partitioning type if available
        if (type === 'window' && fillingMeta?.properties) {
          info.windowPartitioning = this.extractWindowPartitioning(fillingMeta.properties);
        }

        this.openingInfo.set(openingId, info);

        // Also map filling element to same info for easy lookup
        if (fillingElementId) {
          this.openingInfo.set(fillingElementId, info);
        }
      }
    }

    return {
      voidedBy: this.voidedBy,
      filledBy: this.filledBy,
      openingInfo: this.openingInfo,
    };
  }

  private determineOpeningType(ifcType?: string): 'door' | 'window' | 'opening' {
    if (!ifcType) return 'opening';
    const upper = ifcType.toUpperCase();
    if (upper.includes('DOOR')) return 'door';
    if (upper.includes('WINDOW')) return 'window';
    return 'opening';
  }

  /**
   * The occurrence's OperationType unless it is NOTDEFINED or absent, else the type's
   * (`typeOperationType`), else the default. NOTDEFINED states no handedness, so it must not
   * shadow the type's value (#8232).
   */
  private extractDoorOperation(
    properties: Record<string, unknown>,
    typeOperationType?: string
  ): DoorOperationType {
    const psets = properties['Pset_DoorCommon'] as Record<string, unknown> | undefined;
    const stated = (v: unknown): DoorOperationType | null => {
      if (typeof v !== 'string') return null;
      const t = v.replace(/\./g, '').trim().toUpperCase();
      return t === '' || t === 'NOTDEFINED' ? null : (t as DoorOperationType);
    };
    return (
      stated(properties['OperationType']) ??
      stated(psets?.['OperationType']) ??
      stated(typeOperationType) ??
      'SINGLE_SWING_LEFT' // Default
    );
  }

  private extractWindowPartitioning(properties: Record<string, unknown>): WindowPartitioningType {
    // Look for PartitioningType in properties (IfcWindow's own attribute)
    const partitioningType = properties['PartitioningType'] as string | undefined;
    if (partitioningType) {
      return partitioningType as WindowPartitioningType;
    }

    // Look in nested property sets
    const psets = properties['Pset_WindowCommon'] as Record<string, unknown> | undefined;
    if (psets?.['PartitioningType']) {
      return psets['PartitioningType'] as WindowPartitioningType;
    }

    return 'SINGLE_PANEL'; // Default
  }
}

/**
 * Create OpeningRelationships from raw data
 */
export function buildOpeningRelationshipsFromData(
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
