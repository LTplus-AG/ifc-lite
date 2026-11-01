/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import proj4 from 'proj4';
import { lookupEpsgByCode } from '@ifc-lite/data';
import type { ModelSpatialReference } from '@ifc-lite/geometry';
import { useViewerStore, type ViewerState } from '@/store';
import { placementFrameFields, placementFrameKey } from '@/lib/model-placement/persistence';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { resolveProjectionOperation } from '@/lib/geo/reproject';
import { projectedDefinitionInMetres } from '@/lib/geo/proj4-utils';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { planOrthophotoBackground, sampleBackgroundRow, backgroundCalibration, type BackgroundProjection } from '@/lib/terrain-imagery/background-plan';
import { decodeDrapeTexture } from '@/lib/terrain-imagery/raster-texture';
import type { LoadedGeoRaster } from '@/lib/terrain-imagery/read-raster';
import { toast } from '@/components/ui/toast';

/** Read the committed engineering frame, including explicit federation
 * realignment. Proposed georeference edits must not move a background before
 * the model itself has moved. The key is produced by placement persistence. */
export function backgroundReference(frameKey: string): ModelSpatialReference {
  const value = placementFrameFields(frameKey)?.spatialReference;
  if (!value || typeof value !== 'object') throw new Error('Load an IFC model with IfcMapConversion and an EPSG IfcProjectedCRS before its orthophoto.');
  const fields = value as Record<string, unknown>;
  if (typeof fields.horizontal !== 'string' || !/^EPSG:\d+$/.test(fields.horizontal)
    || !fields.localToProjected || typeof fields.localToProjected !== 'object') {
    throw new Error('The model must declare an EPSG coordinate system and a map conversion.');
  }
  const operation = fields.localToProjected as Record<string, unknown>;
  const number = (key: string) => {
    const n = operation[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`Invalid model map conversion: ${key}.`);
    return n;
  };
  const reference: ModelSpatialReference = {
    source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
    horizontal: { id: fields.horizontal, provenance: { source: 'committed workspace frame' } },
    localToProjected: { kind: 'local-projected-affine', eastings: number('eastings'), northings: number('northings'),
      orthogonalHeight: number('orthogonalHeight'), xAxisAbscissa: number('xAxisAbscissa'), xAxisOrdinate: number('xAxisOrdinate'),
      scaleX: number('scaleX'), scaleY: number('scaleY'), scaleZ: number('scaleZ') },
    confidence: 'declared',
  };
  return reference;
}

/** A same-CRS image needs only native-unit conversion, never a datum grid.
 * Cross-CRS placement retains federation's exact-operation requirement. */
export async function orthophotoProjection(sourceCrs: string, targetCrs: string): Promise<BackgroundProjection> {
  if (sourceCrs.toUpperCase() === targetCrs.toUpperCase()) {
    const entry = await lookupEpsgByCode(sourceCrs.split(':')[1]);
    if (!entry?.proj4 || entry.kind !== 'Projected') throw new Error('The image/model CRS has no supported projected definition.');
    const parsed = new proj4.Proj(entry.proj4);
    const unit = 'to_meter' in parsed && typeof parsed.to_meter === 'number' ? parsed.to_meter : 1;
    if (!(unit > 0) || !Number.isFinite(unit)) throw new Error('The raster CRS has invalid units.');
    return { forward: p => [p[0] * unit, p[1] * unit], inverse: p => [p[0] / unit, p[1] / unit] };
  }
  const [source, target] = await Promise.all([resolveProjectionOperation(sourceCrs), resolveProjectionOperation(targetCrs)]);
  if (source.kind !== 'exact' || target.kind !== 'exact') throw new Error('An exact coordinate transformation is unavailable for this image/model pair. Load the required datum grid or reproject the image first.');
  // Raster tags use native CRS units; the model spatial contract uses metres.
  const converter = proj4(source.definition, projectedDefinitionInMetres(target.definition));
  return { forward: p => converter.forward([p[0], p[1]]) as [number, number],
    inverse: p => converter.inverse([p[0], p[1]]) as [number, number] };
}

/** All model bounds must be compared in IFC-world metres, not their possibly
 * different shifted render frames. The legacy result is only a fallback. */
export function orthophotoElevation(state: Pick<ViewerState, 'models' | 'geometryResult'>): number {
  let minimum = Infinity;
  const include = (geometry: ViewerState['geometryResult']) => {
    if (!geometry) return;
    const info = geometry.coordinateInfo;
    const height = info.shiftedBounds.min.y + totalYupOffset(info).y;
    if (Number.isFinite(height)) minimum = Math.min(minimum, height);
  };
  for (const model of state.models.values()) include(model.geometryResult);
  if (!Number.isFinite(minimum)) include(state.geometryResult);
  return (Number.isFinite(minimum) ? minimum : 0) - 0.05;
}

/** An imagery load owns no IFC entities and never resets the model session. */
export async function addOrthophotoBackground(raster: LoadedGeoRaster): Promise<void> {
  const initial = useViewerStore.getState();
  const frameKey = placementFrameKey(initial);
  const reference = backgroundReference(frameKey);
  const crs = raster.placement.crs;
  if (!crs) throw new Error('The orthophoto has no EPSG coordinate system; supply its .prj or .aux.xml.');
  const converter = await orthophotoProjection(crs, reference.horizontal!.id);
  const elevation = orthophotoElevation(initial);
  const plan = planOrthophotoBackground(raster.placement, reference, {
    forward: p => converter.forward([p[0], p[1]]) as [number, number],
    inverse: p => converter.inverse([p[0], p[1]]) as [number, number],
  }, elevation);
  const current = () => {
    const live = useViewerStore.getState();
    if (live.models !== initial.models || placementFrameKey(live) !== frameKey) throw new Error('The models changed while the orthophoto was loading. Open the image again.');
  };
  current();
  const texture = await decodeDrapeTexture(raster, [0, 0, 0]);
  let png: Uint8Array;
  try {
    current();
    const canvas = new OffscreenCanvas(texture.imageWidth, texture.imageHeight);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare orthophoto imagery.');
    context.drawImage(texture.bitmap, 1, 1, texture.imageWidth, texture.imageHeight, 0, 0, texture.imageWidth, texture.imageHeight);
    const pixels = context.getImageData(0, 0, texture.imageWidth, texture.imageHeight).data;
    const output = new Uint8ClampedArray(plan.width * plan.height * 4);
    for (let row = 0; row < plan.height; row++) {
      sampleBackgroundRow(plan, row, pixels, texture.imageWidth, texture.imageHeight, raster.placement.width, raster.placement.height, output);
      if (row % 32 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); current(); }
    }
    canvas.width = plan.width; canvas.height = plan.height;
    context.putImageData(new ImageData(output, plan.width, plan.height), 0, 0);
    png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } finally { texture.bitmap.close(); }
  const id = `orthophoto:${crypto.randomUUID()}`;
  const owner = { kind: 'draft' as const, id };
  try {
    const asset = await appearanceAssets.add(png, { owner });
    current();
    const state = useViewerStore.getState();
    state.addAppearanceReference({ id, sourceId: id, assetId: asset.id, cornersIfcWorld: plan.corners,
      frameKey, visible: true, locked: false, opacity: 1, calibration: backgroundCalibration(plan) });
    appearanceAssets.retain(asset.id, { kind: 'source', id: `appearance:${id}` });
    state.addAppearanceSource({ id, assetId: asset.id, name: `${raster.name} (${crs})`, width: plan.width, height: plan.height });
    state.selectAppearanceReference(id);
    state.requestAppearanceReference({});
    state.openPanelInHome('appearance', 'programmatic');
    toast.success(`${raster.name}: orthophoto background placed in ${reference.horizontal!.id}. Adjust visibility and opacity in Registered drawings.`);
  } finally { appearanceAssets.releaseOwner(owner); }
}
