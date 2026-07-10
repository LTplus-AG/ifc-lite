/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * KMZ Exporter — packages the model + georeference into a KMZ archive so Google
 * Earth can display the 3D model at its correct geolocation.
 *
 * KMZ is a ZIP archive containing:
 *   doc.kml   — KML document with a <Model> positioned at lat/lon + heading
 *   model.dae — the 3D model as **COLLADA**
 *
 * The model is embedded as COLLADA, NOT glTF/GLB: Google Earth's KML <Model> only
 * loads COLLADA (a `.glb` fails with "Unsupported element: Model"). The COLLADA
 * assembly (emission-lit, double-sided materials for Google Earth's lighting), the
 * KML placement (clampToGround by default, or absolute MSL when the caller opts in,
 * plus the IFC grid-north → heading conversion), and the
 * zip are all done in Rust (`ifc-lite-export`, via `GeometryProcessor.exportKmzFromMeshes`)
 * — this is a thin async wrapper over the viewer's already-produced meshes (#1427).
 */

import { GeometryProcessor, type MeshData, type KmzAltitudeMode } from '@ifc-lite/geometry';
import type { LatLon } from './reproject';

export type { KmzAltitudeMode };

export interface KmzOptions {
  /** WGS84 coordinates of the model origin. */
  latLon: LatLon;
  /** Orthogonal height (elevation) in metres. Ignored under clampToGround. */
  altitude: number;
  /** `IfcMapConversion` X-axis grid-north components; omit for heading 0 (true north). */
  xAxisAbscissa?: number;
  xAxisOrdinate?: number;
  /** Meshes to embed — the viewer's already-produced `MeshData` (no re-meshing). */
  meshes: MeshData[];
  /** Display name for the placemark. */
  name?: string;
  /**
   * KML vertical placement (#1427). `'clampToGround'` (default) rests the model on
   * the terrain and ignores `altitude`; `'absolute'` places the origin at `altitude`
   * metres above mean sea level. Omit for the safe, non-floating ground default.
   */
  altitudeMode?: KmzAltitudeMode;
}

/** The slice of `GeometryProcessor` this helper drives — a test seam (see kmz-exporter.test.ts). */
export type KmzProcessor = Pick<GeometryProcessor, 'init' | 'exportKmzFromMeshes' | 'dispose'>;

/**
 * Build a KMZ archive (`doc.kml` + `model.dae`) from the viewer's meshes via the
 * Rust COLLADA/KMZ exporter.
 *
 * `createProcessor` defaults to the real wasm processor; tests inject a stub.
 */
export async function buildKmz(
  opts: KmzOptions,
  createProcessor: () => KmzProcessor = () => new GeometryProcessor(),
): Promise<Uint8Array> {
  // Drop instanced-type templates (geometryClass 2): they are the type-library
  // copy of a shape an occurrence already places, never rendered in Model view
  // (see type-view-visibility.ts), so exporting them would duplicate every
  // instanced element at the type's location in Google Earth.
  const meshes = opts.meshes.filter((m) => (m.geometryClass ?? 0) !== 2);
  const gp = createProcessor();
  try {
    await gp.init();
    const kmz = gp.exportKmzFromMeshes(
      meshes,
      opts.latLon.lat,
      opts.latLon.lon,
      opts.altitude,
      opts.xAxisAbscissa,
      opts.xAxisOrdinate,
      opts.name ?? 'IFC Model',
      opts.altitudeMode,
    );
    if (kmz == null) throw new Error('KMZ export returned no data');
    return kmz;
  } finally {
    gp.dispose();
  }
}
