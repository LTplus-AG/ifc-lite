/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The model's footprint polygon on the Location panel's minimap.
 *
 * Split out of LocationMap.tsx, which was past the ~400-line rule. These two
 * are a matched pair — every source and layer `add` has a `remove` — and that
 * pairing is the thing worth being able to read in one screen, and to test:
 * a layer left behind on a style reload throws on the next add.
 */

import type { Feature } from 'geojson';
// Type-only: erased at compile time, so this module never pulls maplibre in.
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';

/** The MapLibre surface these two need. Structural, so a test can stand in. */
export interface FootprintMap {
  // `unknown` rather than a GeoJSON-source shape: MapLibre types `getSource` as
  // the `Source` union, which has no `setData`, so a narrower declaration here
  // would make the real Map unassignable to this interface.
  getSource(id: string): unknown;
  addSource(id: string, source: SourceSpecification): void;
  addLayer(layer: AddLayerObject): void;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  removeSource(id: string): void;
}

export const FOOTPRINT_SOURCE = 'building-footprint';
export const FOOTPRINT_FILL_LAYER = 'building-footprint-fill';
export const FOOTPRINT_OUTLINE_LAYER = 'building-footprint-outline';

/** Add or update the building footprint GeoJSON polygon on a MapLibre map */
export function addFootprintToMap(map: FootprintMap, ring: [number, number][]) {
  const geojson: Feature = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
  };

  const existing = map.getSource(FOOTPRINT_SOURCE) as { setData(data: Feature): void } | undefined;
  if (existing) {
    existing.setData(geojson);
    return;
  }

  map.addSource(FOOTPRINT_SOURCE, { type: 'geojson', data: geojson });

  map.addLayer({
    id: FOOTPRINT_FILL_LAYER,
    type: 'fill',
    source: FOOTPRINT_SOURCE,
    paint: {
      'fill-color': '#14b8a6',
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.15, 18, 0.25],
    },
  });

  map.addLayer({
    id: FOOTPRINT_OUTLINE_LAYER,
    type: 'line',
    source: FOOTPRINT_SOURCE,
    paint: {
      'line-color': '#0d9488',
      'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 18, 2.5],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.7, 18, 1],
    },
  });

}

/** Remove footprint layers and source from a MapLibre map */
export function removeFootprintFromMap(map: FootprintMap) {
  if (map.getLayer(FOOTPRINT_OUTLINE_LAYER)) map.removeLayer(FOOTPRINT_OUTLINE_LAYER);
  if (map.getLayer(FOOTPRINT_FILL_LAYER)) map.removeLayer(FOOTPRINT_FILL_LAYER);
  if (map.getSource(FOOTPRINT_SOURCE)) map.removeSource(FOOTPRINT_SOURCE);
}
