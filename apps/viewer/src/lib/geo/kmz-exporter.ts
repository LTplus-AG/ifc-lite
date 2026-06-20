/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * KMZ Exporter — packages a GLB model + georeference into a KMZ archive so Google
 * Earth can display the 3D model at its correct geolocation.
 *
 * KMZ is a ZIP archive containing:
 *   doc.kml   — KML document with a <Model> positioned at lat/lon/alt + heading
 *   model.glb — the 3D model in glTF binary format
 *
 * The KML assembly, the IFC grid-north → KML heading conversion, and the zip are all
 * done in Rust (`ifc-lite-export`, via `GeometryProcessor.exportKmz`) — this is a thin
 * async wrapper. The GLB is produced upstream by the Rust GLB exporter.
 */

import { GeometryProcessor } from '@ifc-lite/geometry';
import type { LatLon } from './reproject';

export interface KmzOptions {
  /** WGS84 coordinates of the model origin */
  latLon: LatLon;
  /** Orthogonal height (elevation) in metres */
  altitude: number;
  /** `IfcMapConversion` X-axis grid-north components; omit for heading 0 (true north). */
  xAxisAbscissa?: number;
  xAxisOrdinate?: number;
  /** GLB model binary data */
  glb: Uint8Array;
  /** Display name for the placemark */
  name?: string;
}

/** The slice of `GeometryProcessor` this helper drives — a test seam (see kmz-exporter.test.ts). */
export type KmzProcessor = Pick<GeometryProcessor, 'init' | 'exportKmz' | 'dispose'>;

/**
 * Build a KMZ archive (`doc.kml` + `model.glb`) via the Rust exporter.
 *
 * `createProcessor` defaults to the real wasm processor; tests inject a stub.
 */
export async function buildKmz(
  opts: KmzOptions,
  createProcessor: () => KmzProcessor = () => new GeometryProcessor(),
): Promise<Uint8Array> {
  const gp = createProcessor();
  try {
    await gp.init();
    const kmz = gp.exportKmz(
      opts.glb,
      opts.latLon.lat,
      opts.latLon.lon,
      opts.altitude,
      opts.xAxisAbscissa,
      opts.xAxisOrdinate,
      opts.name ?? 'IFC Model',
    );
    if (kmz == null) throw new Error('KMZ export returned no data');
    return kmz;
  } finally {
    gp.dispose();
  }
}
