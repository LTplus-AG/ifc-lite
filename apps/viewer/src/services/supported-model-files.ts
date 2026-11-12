/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one list of file extensions the viewer can ingest.
 *
 * Every entry point that names extensions derives them from here: the
 * `<input type="file">` accept strings, the drag/drop and picker guards
 * (`isSupportedModelFile`), the File System Access picker's accept
 * filter in `./file-system-access.ts`, and the welcome card's format list. Keeping them derived rather than
 * hand-copied is what stops one path from advertising a format another
 * path silently refuses — `.ifczip` was missing from the picker filter
 * while every other path accepted it, so a zipped IFC appeared greyed out
 * in the Chromium Open dialog.
 */

import { GEO_RASTER_FILE_EXTENSIONS, isGeoRasterFile } from '@/lib/terrain-imagery/raster-bundle';
import { gaussianAdmissionEnabled } from '@/hooks/ingest/gaussianAdmissionPolicy';
import type { TranslationKey } from '@/i18n';

/** One family of formats, as the welcome card names it. */
export interface FileFormatGroup {
  /** Catalogue key of the family's name. */
  readonly labelKey: TranslationKey;
  readonly extensions: readonly string[];
  /** The format behind an extension that does not name it: `.xml` is LandXML. */
  readonly formatName?: string;
}

/**
 * Model formats routed to the model-load pipeline, by family. This is the
 * source: `MODEL_FILE_EXTENSIONS` is these groups flattened, so a format
 * cannot load without belonging to a named group.
 */
export const MODEL_FORMAT_GROUPS: readonly FileFormatGroup[] = [
  { labelKey: 'viewportLighting.container.emptyState.formats.ifc', extensions: ['.ifc', '.ifcx', '.ifczip'] },
  { labelKey: 'viewportLighting.container.emptyState.formats.gltf', extensions: ['.glb', '.gltf'] },
  {
    labelKey: 'viewportLighting.container.emptyState.formats.pointClouds',
    extensions: ['.las', '.laz', '.ply', '.pcd', '.e57', '.pts', '.xyz'],
  },
  { labelKey: 'viewportLighting.container.emptyState.formats.terrain', extensions: ['.xml'], formatName: 'LandXML' },
];

/**
 * Reference underlays. `.dxf` is offered by every picker but splits off to
 * the 2D ingest path before model routing, so it is deliberately not part
 * of `MODEL_FILE_EXTENSIONS` / `isSupportedModelFile`.
 */
const REFERENCE_FORMAT_GROUP: FileFormatGroup = {
  labelKey: 'viewportLighting.container.emptyState.formats.underlays',
  extensions: ['.dxf'],
};

/** Offered exactly when the loader admits captures, i.e. unless the build's kill
 * switch is set (#8568). Gaussian `.ply` shares the point-cloud extension and is
 * told apart by content. */
const GAUSSIAN_FORMAT_GROUPS: readonly FileFormatGroup[] = gaussianAdmissionEnabled()
  ? [{ labelKey: 'viewportLighting.container.emptyState.formats.splats', extensions: ['.splat'] }]
  : [];

/**
 * Every family a drop on the viewport opens, in the order the welcome card
 * lists them. Georeferenced rasters are left out: they only drape on a
 * terrain that is already loaded.
 */
export const DROP_FORMAT_GROUPS: readonly FileFormatGroup[] = [
  ...MODEL_FORMAT_GROUPS,
  REFERENCE_FORMAT_GROUP,
  ...GAUSSIAN_FORMAT_GROUPS,
];

const extensionsOf = (groups: readonly FileFormatGroup[]): readonly string[] => groups.flatMap((group) => group.extensions);

/** Model formats routed to the model-load pipeline. */
export const MODEL_FILE_EXTENSIONS = extensionsOf(MODEL_FORMAT_GROUPS);

const GAUSSIAN_FILE_EXTENSIONS = extensionsOf(GAUSSIAN_FORMAT_GROUPS);

export const REFERENCE_FILE_EXTENSIONS = REFERENCE_FORMAT_GROUP.extensions;

/** Everything a file picker should offer the user. */
export const PICKER_FILE_EXTENSIONS: readonly string[] = [
  ...MODEL_FILE_EXTENSIONS,
  ...GAUSSIAN_FILE_EXTENSIONS,
  ...REFERENCE_FILE_EXTENSIONS,
  '.bin', '.png', '.jpg', '.jpeg',
  // #5942: georeferenced imagery and its sidecars, draped on a loaded terrain.
  ...GEO_RASTER_FILE_EXTENSIONS,
];

/** `accept` attribute for the hidden `<input type="file">` elements. */
export const FILE_ACCEPT = PICKER_FILE_EXTENSIONS.join(',');

/** Extensions the viewer can ingest (IFC / IFCX / GLB / point clouds). */
export function isSupportedModelFile(f: File): boolean {
  const n = f.name.toLowerCase();
  return [...MODEL_FILE_EXTENSIONS, ...GAUSSIAN_FILE_EXTENSIONS].some((ext) => n.endsWith(ext));
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
