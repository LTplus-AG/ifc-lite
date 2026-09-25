/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one list of file extensions the viewer can ingest.
 *
 * Every entry point that names extensions derives them from here: the
 * `<input type="file">` accept strings, the drag/drop and picker guards
 * (`isSupportedModelFile`), and the File System Access picker's accept
 * filter in `./file-system-access.ts`. Keeping them derived rather than
 * hand-copied is what stops one path from advertising a format another
 * path silently refuses — `.ifczip` was missing from the picker filter
 * while every other path accepted it, so a zipped IFC appeared greyed out
 * in the Chromium Open dialog.
 */

import { GEO_RASTER_FILE_EXTENSIONS, isGeoRasterFile } from '@/lib/terrain-imagery/raster-bundle';

/** Model formats routed to the model-load pipeline. */
export const MODEL_FILE_EXTENSIONS = [
  '.ifc',
  '.ifcx',
  '.ifczip',
  '.glb',
  '.gltf',
  '.las',
  '.laz',
  '.ply',
  '.pcd',
  '.e57',
  '.pts',
  '.xyz',
  '.xml',
] as const;

/** Formats exposed by the compact mobile toolbar's single-file flow. */
export const MOBILE_MODEL_FILE_EXTENSIONS = [
  '.ifc',
  '.ifcx',
  '.ifczip',
  '.glb',
  '.xml',
] as const;

/**
 * Reference underlays. `.dxf` is offered by every picker but splits off to
 * the 2D ingest path before model routing, so it is deliberately not part
 * of `MODEL_FILE_EXTENSIONS` / `isSupportedModelFile`.
 */
export const REFERENCE_FILE_EXTENSIONS = ['.dxf'] as const;

/** Everything a file picker should offer the user. */
export const PICKER_FILE_EXTENSIONS: readonly string[] = [
  ...MODEL_FILE_EXTENSIONS,
  ...REFERENCE_FILE_EXTENSIONS,
  '.bin', '.png', '.jpg', '.jpeg',
  // #5942: georeferenced imagery and its sidecars, draped on a loaded terrain.
  ...GEO_RASTER_FILE_EXTENSIONS,
];

/** `accept` attribute for the hidden `<input type="file">` elements. */
export const FILE_ACCEPT = PICKER_FILE_EXTENSIONS.join(',');

/** `accept` attribute for the mobile toolbar's deliberately smaller format set. */
export const MOBILE_FILE_ACCEPT = MOBILE_MODEL_FILE_EXTENSIONS.join(',');

/** Extensions the viewer can ingest (IFC / IFCX / GLB / point clouds). */
export function isSupportedModelFile(f: File): boolean {
  const n = f.name.toLowerCase();
  return MODEL_FILE_EXTENSIONS.some((ext) => n.endsWith(ext));
}

/** Case-insensitive guard for formats handled by the mobile toolbar. */
export function isSupportedMobileModelFile(f: File): boolean {
  const n = f.name.toLowerCase();
  return MOBILE_MODEL_FILE_EXTENSIONS.some((ext) => n.endsWith(ext));
}

/** Files retained alongside a `.gltf` document until its local bundle is packed. */
function isGltfBundleFile(f: File): boolean {
  return /\.(?:gltf|bin|png|jpe?g)$/i.test(f.name);
}

/**
 * Files that are not models on their own but travel with one through routing:
 * a `.gltf`'s buffers and textures, and a georeferenced raster with its world
 * file / `.prj` (#5942). `prepareModelFiles` packs both before `loadFile`.
 */
export function isModelSidecarFile(f: File): boolean {
  return isGltfBundleFile(f) || isGeoRasterFile(f);
}
