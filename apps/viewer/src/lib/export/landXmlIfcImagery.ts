/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Carry a terrain's draped imagery into the IFC4X3 export (#5942, mapping
 * spec §15.5).
 *
 * Three steps, each owned by code that already exists for it:
 *
 * 1. `landXmlToIfc` writes the terrain exactly as §4.1 says, plus the imagery
 *    PROVENANCE in `LandXML_Conversion`, and names each TIN's element.
 * 2. The appearance workspace's planner (`plan_appearance`, the Rust texture
 *    writer every textured building element goes through) textures those
 *    elements with a `planar` / `world` mapping that IS the drape's projection
 *    scaled to metres. There is no second texture writer.
 * 3. The planned entities are appended with the exporter's own schema-aware
 *    serializer, and the STEP text and the image ship side by side in an
 *    `.ifcZIP`, the image referenced by its entry name — which is how
 *    `textureResources.ts` resolves every `.ifcZIP` texture on load.
 *
 * If step 2 refuses (its budgets, or an exclusion), the imagery is refused by
 * name and the terrain exports untextured — never with provenance claiming a
 * texture that is not in the file.
 */

import { strToU8, zipSync } from 'fflate';
import { landXmlToIfc, type LandXmlIfcImagery, type LandXmlIfcOptions, type LandXmlIfcSource } from '@ifc-lite/create';
import { serializeEntityArgs } from '@ifc-lite/export';
import type { AppearanceMapping, AppearancePlan, AppearanceRequest } from '@/lib/appearance/planner-types.js';
import { drapeUv, uvCovered, type DrapeProjection } from '@/lib/terrain-imagery/drape-projection.js';
import type { TerrainImageryDrape } from '@/lib/terrain-imagery/drape-state.js';
import { encodePng } from '@/lib/terrain-imagery/png-encode.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics.js';
import { computeFullSourceHash } from '@/utils/sourceContentHash.js';

/** The planner, as the browser (a worker) or a test (the wasm directly) runs it. */
export type AppearancePlanRunner = (source: Uint8Array, request: AppearanceRequest) => Promise<AppearancePlan>;

export type LandXmlIfcArchiveResult =
  | {
    status: 'exported';
    /** A `.ifcZIP` when the imagery was written, plain STEP text otherwise. */
    content: Uint8Array | string;
    extension: '.ifczip' | '.ifc';
    surfaces: number;
    surveyPoints: number;
    alignments: number;
    /** What happened to the imagery: written, none to write, or refused and why. */
    imagery: { status: 'exported'; entryName: string } | { status: 'none' } | { status: 'refused'; reason: string };
  }
  | { status: 'refused'; reason: string };

/**
 * The covered fraction over the WRITTEN TIN's vertices (§15.3): points of a
 * rendered surface referenced by at least one visible face.
 */
export function writtenCoveredFraction(document: LandXmlTinDocument, projection: DrapeProjection): number {
  let total = 0;
  let covered = 0;
  for (const surface of document.surfaces) {
    if (surface.renderState !== 'rendered') continue;
    const referenced = new Set<string>();
    surface.faces.forEach((face, index) => { if (surface.faceVisibility[index] !== false) face.forEach((id) => referenced.add(id)); });
    for (const point of surface.points) {
      if (!referenced.has(point.id)) continue;
      referenced.delete(point.id);
      total += 1;
      if (uvCovered(...drapeUv(projection, point.easting, point.northing))) covered += 1;
    }
  }
  return total > 0 ? covered / total : 0;
}

/**
 * The drape's projection as the planner's `planar` / `world` mapping. The
 * IFC coordinates are the terrain's native plan coordinates scaled to metres
 * (§4.1), so the projection is carried over by that same scale.
 */
export function plannerMapping(projection: DrapeProjection, linearScaleToMeters: number): AppearanceMapping {
  const s = linearScaleToMeters;
  return {
    kind: 'planar', frame: 'world',
    origin: [projection.origin[0] * s, projection.origin[1] * s, 0],
    axisU: [projection.axisU[0], projection.axisU[1], 0],
    axisV: [projection.axisV[0], projection.axisV[1], 0],
    metresPerTile: [projection.extent[0] * s, projection.extent[1] * s],
  };
}

/** A safe relative `.ifcZIP` entry name the planner's URI rules accept. */
export function imageEntryName(sourceName: string, extension: string, modelEntry: string): string {
  const stem = sourceName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'imagery';
  const name = `${stem}${extension}`;
  return name.toLowerCase() === modelEntry.toLowerCase() ? `${stem}-imagery${extension}` : name;
}

/** The image to ship: PNG/JPEG as supplied, a GeoTIFF as a lossless PNG (§15.5). */
async function shippedImage(image: NonNullable<TerrainImageryDrape['image']>): Promise<{ bytes: Uint8Array; extension: string; transcoded: boolean }> {
  if (image.mime === 'image/png') return { bytes: image.bytes, extension: '.png', transcoded: false };
  if (image.mime === 'image/jpeg') return { bytes: image.bytes, extension: '.jpg', transcoded: false };
  const { fromArrayBuffer } = await import('geotiff');
  const tiff = await fromArrayBuffer(image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength) as ArrayBuffer);
  const raster = await tiff.getImage(0);
  if (raster.getBitsPerSample(0) !== 8) throw new Error('only 8-bit GeoTIFF imagery can be shipped as PNG');
  const width = raster.getWidth();
  const height = raster.getHeight();
  const rgb = await raster.readRGB({ interleave: true, enableAlpha: true });
  const channels = rgb.length / (width * height);
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) rgba[pixel * 4 + channel] = rgb[pixel * channels + channel];
    rgba[pixel * 4 + 3] = channels === 4 ? rgb[pixel * 4 + 3] : 255;
  }
  return { bytes: encodePng(rgba, width, height), extension: '.png', transcoded: true };
}

/** Append planned entities to the DATA section with the exporter's serializer. */
export function appendPlannedEntities(content: string, plan: AppearancePlan): string {
  const end = content.lastIndexOf('ENDSEC;');
  if (end < 0) throw new Error('The converted file has no DATA section to extend.');
  const lines = plan.created.map((entity) => (
    `#${entity.expressId}=${entity.type.toUpperCase()}(${serializeEntityArgs(entity.type, entity.attributes, 'IFC4X3')});\n`
  )).join('');
  return content.slice(0, end) + lines + content.slice(end);
}

function maxExpressId(content: string): number {
  let max = 0;
  for (const match of content.matchAll(/^#(\d+)=/gm)) max = Math.max(max, Number(match[1]));
  return max;
}

/**
 * Convert one LandXML document, with its draped imagery when that imagery is
 * exportable (§15.2 item 7: never tiles). `options` are the converter's own.
 */
export async function landXmlToIfcArchive(
  document: LandXmlTinDocument,
  source: LandXmlIfcSource,
  options: LandXmlIfcOptions,
  modelEntry: string,
  drape: TerrainImageryDrape | undefined,
  plan: AppearancePlanRunner,
): Promise<LandXmlIfcArchiveResult> {
  const plain = (imagery: Extract<LandXmlIfcArchiveResult, { status: 'exported' }>['imagery']): LandXmlIfcArchiveResult => {
    const result = landXmlToIfc(source, options);
    if (result.status === 'refused') return { status: 'refused', reason: result.reason };
    return {
      status: 'exported', content: result.content, extension: '.ifc', imagery,
      surfaces: result.coverage.surfaces, surveyPoints: result.coverage.surveyPoints, alignments: result.coverage.alignments ?? 0,
    };
  };
  if (!drape) return plain({ status: 'none' });
  if (drape.source === 'tiles' || !drape.image) {
    return plain({ status: 'refused', reason: 'Map-tile imagery is draped in the viewer only and is never exported.' });
  }
  if (!document.units) return plain({ status: 'refused', reason: 'The terrain has no resolved units to scale the texture mapping by.' });
  const shipped = await shippedImage(drape.image);
  const entryName = imageEntryName(drape.sourceName, shipped.extension, modelEntry);
  const shippedHash = shipped.transcoded ? await computeFullSourceHash(shipped.bytes) : null;
  const imagery: LandXmlIfcImagery = {
    sourceFileName: drape.sourceName,
    sourceHash: drape.image.sha256,
    placement: drape.placement === 'GeoTIFF' ? 'GeoTIFF' : 'world file',
    crs: drape.imageCrs,
    projection: {
      crs: drape.projection.crs, origin: drape.projection.origin, axisU: drape.projection.axisU,
      axisV: drape.projection.axisV, extent: drape.projection.extent,
    },
    coveredFraction: writtenCoveredFraction(document, drape.projection),
    ...(shipped.transcoded ? { shippedFileName: entryName, ...(shippedHash ? { shippedHash } : {}) } : {}),
  };
  const result = landXmlToIfc(source, { ...options, imagery });
  if (result.status === 'refused') return { status: 'refused', reason: result.reason };
  const productIds = (result.surfaceElements ?? []).map((element) => element.expressId);
  if (productIds.length === 0) return plain({ status: 'refused', reason: 'No terrain surface was written to carry the imagery.' });
  let planned: AppearancePlan;
  try {
    planned = await plan(new TextEncoder().encode(result.content), {
      schema: 'IFC4X3', sourceRevision: 'landxml-imagery-export', nextExpressId: maxExpressId(result.content) + 1,
      productIds, imageUri: entryName, repeatS: false, repeatT: false,
      mapping: plannerMapping(drape.projection, document.units.linearScaleToMeters),
    });
  } catch (error) {
    return plain({ status: 'refused', reason: error instanceof Error ? error.message : String(error) });
  }
  if (planned.exclusions.length > 0 || planned.edits.length > 0 || planned.removed.length > 0 || planned.items.length !== productIds.length) {
    const reasons = planned.exclusions.map((exclusion) => exclusion.reason).join('; ');
    return plain({ status: 'refused', reason: reasons || 'The appearance planner would have rewritten existing entities.' });
  }
  const content = appendPlannedEntities(result.content, planned);
  const archive = zipSync({
    [modelEntry]: [strToU8(content), { level: 6 }],
    // Already-compressed image bytes are stored, not deflated again.
    [entryName]: [shipped.bytes, { level: 0 }],
  });
  return {
    status: 'exported', content: archive, extension: '.ifczip', imagery: { status: 'exported', entryName },
    surfaces: result.coverage.surfaces, surveyPoints: result.coverage.surveyPoints, alignments: result.coverage.alignments ?? 0,
  };
}
