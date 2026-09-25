/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The active model's georeference context (its map conversion, projected CRS
 * and coordinate info), published by `CesiumPlacementGizmo` — mounted next
 * to the Cesium overlay in `ViewportContainer`, wherever the expensive
 * federated-geometry `georef` memo already lives — so the docked `placement`
 * side panel's Georeference tab (#5505, wherever it is mounted: sidebar,
 * float, pop-out) can read it without recomputing that memo a second time.
 * Same `useSyncExternalStore` shape as `lib/drawing/drawing-runtime.ts`
 * (#5492), which solved the identical "runtime lives in the viewport, its
 * view can be mounted anywhere" problem for the 2D drawing.
 */

import { useSyncExternalStore } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';

export interface PlacementGeorefContext {
  modelId: string;
  mapConversion: MapConversion;
  baseMapConversion: MapConversion;
  projectedCRS?: ProjectedCRS;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale?: number;
}

let context: PlacementGeorefContext | null = null;
const listeners = new Set<() => void>();

export function publishPlacementGeorefContext(next: PlacementGeorefContext | null): void {
  context = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getContext(): PlacementGeorefContext | null {
  return context;
}

export function usePlacementGeorefContext(): PlacementGeorefContext | null {
  return useSyncExternalStore(subscribe, getContext, getContext);
}
