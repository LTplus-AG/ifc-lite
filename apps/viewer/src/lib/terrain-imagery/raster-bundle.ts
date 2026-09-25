/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Group a picked or dropped georeferenced raster with its sidecars (#5942).
 *
 * A raster's placement and CRS usually live in files BESIDE it — a world file
 * (`ortho.pgw`), a `.prj`, a GDAL `ortho.png.aux.xml` — and `loadFile` takes
 * one `File`. So, exactly as a `.gltf` and its sidecars are packed before
 * routing, the raster and its sidecars travel as one {@link GeoRasterBundle}
 * into the canonical load path, which drapes it on the loaded terrain rather
 * than creating a model.
 *
 * Note the `.aux.xml` case: it ends in `.xml`, the LandXML extension. It must
 * be claimed here, or it would be handed to the LandXML parser as a survey.
 */

const TIFF = /\.tiff?$/i;
const WEB_IMAGE = /\.(png|jpe?g)$/i;
const WORLD_FILE = /\.(tfw|tifw|tiffw|pgw|pngw|jgw|jpgw|jpegw|wld)$/i;
const PRJ = /\.prj$/i;
const AUX_XML = /\.aux\.xml$/i;

/** Extensions a picker must offer so a raster and its sidecars can be chosen. */
export const GEO_RASTER_FILE_EXTENSIONS = [
  '.tif', '.tiff', '.tfw', '.tifw', '.pgw', '.pngw', '.jgw', '.jpgw', '.wld', '.prj',
] as const;

/** One raster and the sidecars that place it. */
export class GeoRasterBundle extends File {
  constructor(
    readonly image: File,
    readonly worldFile: File | null,
    /** CRS sidecars in the order they are consulted: the image's own `.aux.xml`, then its `.prj`. */
    readonly crsFiles: readonly File[],
  ) {
    super([image], image.name, { type: image.type, lastModified: image.lastModified });
  }

  get isGeoTiff(): boolean {
    return TIFF.test(this.image.name);
  }
}

/** Whether a file can take part in a raster bundle (the image or a sidecar). */
export function isGeoRasterFile(file: File): boolean {
  return TIFF.test(file.name) || WORLD_FILE.test(file.name) || PRJ.test(file.name) || AUX_XML.test(file.name);
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

export interface ResolvedGeoRasters {
  bundles: GeoRasterBundle[];
  /** Everything that is not part of a raster bundle, in pick order. */
  rest: File[];
  /** Sidecars with no image beside them — reported, never routed as models. */
  orphans: File[];
}

/**
 * Split a pick into raster bundles and everything else.
 *
 * A TIFF is always a raster. A PNG/JPEG is one only when a world file, `.prj`
 * or `.aux.xml` names it: alone it is far more often a glTF texture, and the
 * glTF route's refusal already says what is missing.
 */
export function resolveGeoRasterBundles(files: readonly File[]): ResolvedGeoRasters {
  const worldFiles = new Map<string, File>();
  const prjFiles = new Map<string, File>();
  const auxFiles = new Map<string, File>();
  for (const file of files) {
    if (WORLD_FILE.test(file.name)) worldFiles.set(stem(file.name), file);
    else if (PRJ.test(file.name)) prjFiles.set(stem(file.name), file);
    else if (AUX_XML.test(file.name)) auxFiles.set(file.name.slice(0, -'.aux.xml'.length).toLowerCase(), file);
  }
  const claimed = new Set<File>();
  const bundles: GeoRasterBundle[] = [];
  for (const file of files) {
    const isImage = TIFF.test(file.name) || WEB_IMAGE.test(file.name);
    if (!isImage) continue;
    const key = stem(file.name);
    const worldFile = worldFiles.get(key) ?? null;
    const crsFiles = [auxFiles.get(file.name.toLowerCase()), prjFiles.get(key)].filter((part): part is File => part !== undefined);
    const raster = TIFF.test(file.name) || worldFile !== null || crsFiles.length > 0;
    if (!raster) continue;
    bundles.push(new GeoRasterBundle(file, worldFile, crsFiles));
    for (const part of [file, worldFile, ...crsFiles]) if (part) claimed.add(part);
  }
  const rest: File[] = [];
  const orphans: File[] = [];
  for (const file of files) {
    if (claimed.has(file)) continue;
    if (WORLD_FILE.test(file.name) || PRJ.test(file.name) || AUX_XML.test(file.name)) orphans.push(file);
    else rest.push(file);
  }
  return { bundles, rest, orphans };
}
