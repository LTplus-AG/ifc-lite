/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Synchronous metadata for entities whose CPU geometry was released (#10264):
 * bounds and mesh area kept by the backing without any triangle array, so
 * panels that need only a box or an area answer without reading geometry
 * back. Registered by the backing tap; absent (undefined) means unavailable,
 * never zero.
 */

export interface ReleasedEntityBounds { min: [number, number, number]; max: [number, number, number] }
export interface ReleasedEntityArea { area: number; incomplete: boolean }

export interface ReleasedGeometryMetadata {
  /** Flat-mesh bounds in the mesh frame (`origin + positions`), as `PropertiesPanel` folds them. */
  bounds(modelId: string, globalId: number): ReleasedEntityBounds | undefined;
  /** Mesh surface area as `collectMeshAreas` sums it from the model's store list. */
  area(modelId: string, globalId: number): ReleasedEntityArea | undefined;
}

let provider: ReleasedGeometryMetadata | null = null;

export function setReleasedGeometryMetadata(next: ReleasedGeometryMetadata | null): void { provider = next; }
export function releasedGeometryMetadata(): ReleasedGeometryMetadata | null { return provider; }
