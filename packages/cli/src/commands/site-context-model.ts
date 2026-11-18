/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The site centre from a model's georeferencing, read through
 * `@ifc-lite/parser`'s on-demand extractor. Only the map conversion's origin
 * is used: the model's rotation and scale belong to placing the model, which
 * the viewer does through its federation spatial reference, never to the
 * site context.
 */

import { resolveCrs, type CrsTransformer } from '@ifc-lite/geo';
import { computeAngleToGridNorth, extractGeoreferencingOnDemand, type GeoreferenceInfo, type IfcDataStore } from '@ifc-lite/parser';

/** The model cannot give a site centre; the message says how to fix it. */
export class SiteContextModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteContextModelError';
  }
}

const FIX = 'add an IfcMapConversion to EPSG:2056 (Eastings, Northings, OrthogonalHeight in the map unit) in the authoring tool or the viewer\'s georeference editor, or pass --centre E,N';

export interface ModelCentre {
  centre: { x: number; y: number };
  crs: {
    name: string;
    /** `literal`: the file says EPSG:2056. `name`: @ifc-lite/geo resolved its name to EPSG:2056. `reprojected`: another CRS, centre converted. */
    matched: 'literal' | 'name' | 'reprojected';
    epsg: number | null;
    datumShift?: string;
  };
  /** Map units → metres applied to Eastings/Northings. */
  mapUnitToMetres: number;
  mapUnitSource: 'MapUnit' | 'project length unit';
  verticalDatum: string | null;
  /** The model's own rotation, reported only: it is not applied to the context. */
  rotationDegrees: number | null;
  /** IfcMapConversion Eastings/Northings in metres, in EPSG:2056 (the reprojected point for another CRS). */
  conversionOrigin: { x: number; y: number };
  /** IfcMapConversion Eastings/Northings in metres, in the model's own CRS. */
  sourceOrigin: { x: number; y: number };
  /**
   * A point in the model's own CRS (metres) to EPSG:2056, or `null` when it cannot be converted.
   * The identity for an EPSG:2056 model; through WGS84 for another CRS, so grid convergence and
   * scale differences are applied per point rather than to offsets added at the origin.
   */
  toLv95(x: number, y: number): { x: number; y: number } | null;
  /** IfcMapConversion.Scale as stated (absent: IFC's default 1). */
  conversionScale: number | null;
  /** Things the user should know that did not stop the run. */
  warnings: string[];
}

const LN02 = /\bLN\s*-?\s*02\b|EPSG:?\s*5728\b/i;

function mapUnitScale(info: GeoreferenceInfo, store: IfcDataStore): { scale: number; source: ModelCentre['mapUnitSource'] } {
  const crsScale = info.projectedCRS?.mapUnitScale;
  if (crsScale !== undefined) return { scale: crsScale, source: 'MapUnit' };
  // IFC: without MapUnit, the project's length unit applies.
  return { scale: store.lengthUnitScale ?? 1, source: 'project length unit' };
}

/**
 * `@ifc-lite/parser` reads an IfcProjectedCRS.MapUnit it cannot resolve as
 * METRE with scale 1, the same answer as a declared metre, so the two cannot
 * be told apart here. Whenever the map unit reads as metres the run says the
 * unit is assumed, rather than silently trusting a possibly unreadable unit.
 */
export const METRE_MAP_UNIT_WARNING =
  'IfcProjectedCRS.MapUnit reads as METRE; an unreadable MapUnit also reads as METRE, so the map conversion is assumed to be in metres: check the model\'s map unit';

function metreFallbackPossible(info: GeoreferenceInfo): boolean {
  const crs = info.projectedCRS;
  return crs?.mapUnit === 'METRE' && crs.mapUnitScale === 1;
}

async function lv95(): Promise<CrsTransformer> {
  const t = await resolveCrs({ epsg: 2056 });
  if (!t) throw new Error('@ifc-lite/geo could not resolve EPSG:2056');
  return t;
}

export async function siteCentreFromModel(store: IfcDataStore): Promise<ModelCentre> {
  const info = extractGeoreferencingOnDemand(store);
  const mc = info?.mapConversion;
  const crsInfo = info?.projectedCRS;
  const usable = info?.source === 'mapConversion' || info?.source === 'ePSetMapConversion';
  if (!info || !mc || !crsInfo || !usable) {
    const what = info?.source === 'siteLocation'
      ? 'only IfcSite RefLatitude/RefLongitude, no map conversion'
      : info?.source === 'rigidOperation' ? 'an IfcRigidOperation, not a map conversion' : 'no map conversion';
    throw new SiteContextModelError(`the model has ${what}; site context needs an IfcMapConversion to EPSG:2056: ${FIX}`);
  }
  const warnings: string[] = [];
  const name = crsInfo.name?.trim() ?? '';

  const vertical = crsInfo.verticalDatum?.trim() || null;
  if (vertical && !LN02.test(vertical)) {
    throw new SiteContextModelError(
      `the model states vertical datum "${vertical}", but swissALTI3D heights are LN02 (EPSG:5728); refusing to mix height systems. ` +
        'If the model is in fact LN02, correct IfcProjectedCRS.VerticalDatum in the authoring tool or the viewer\'s georeference editor',
    );
  }
  if (!vertical) warnings.push('the model states no vertical datum; the site context is in LN02 (EPSG:5728) heights, check the model uses the same');

  const unit = mapUnitScale(info, store);
  if (metreFallbackPossible(info)) warnings.push(METRE_MAP_UNIT_WARNING);
  if (unit.source === 'project length unit') warnings.push(`IfcProjectedCRS has no MapUnit; the project length unit (${unit.scale} m) was applied to Eastings/Northings`);
  const e = mc.eastings * unit.scale;
  const n = mc.northings * unit.scale;
  const base = {
    mapUnitToMetres: unit.scale,
    mapUnitSource: unit.source,
    verticalDatum: vertical,
    rotationDegrees: computeAngleToGridNorth(mc.xAxisAbscissa, mc.xAxisOrdinate),
    conversionOrigin: { x: e, y: n },
    sourceOrigin: { x: e, y: n },
    toLv95: (x: number, y: number) => ({ x, y }),
    conversionScale: mc.scale ?? null,
    warnings,
  };

  if (/^EPSG:\s*2056$/i.test(name)) {
    return { ...base, centre: { x: e, y: n }, crs: { name, matched: 'literal', epsg: 2056 } };
  }
  const t = await resolveCrs({ name: name || undefined, wkt: crsInfo.wellKnownText });
  if (!t || t.kind !== 'projected') {
    throw new SiteContextModelError(`the model's CRS "${name}" is not EPSG:2056 and could not be resolved to a projected CRS; ${FIX}`);
  }
  if (t.epsg === 2056) {
    return { ...base, centre: { x: e, y: n }, crs: { name, matched: 'name', epsg: 2056 } };
  }
  // Another projected CRS: convert only the centre point, through WGS84.
  const wgs = t.toWgs84([e, n]);
  const target = await lv95();
  const p = wgs ? target.fromWgs84([wgs[0], wgs[1]]) : null;
  if (!p) throw new SiteContextModelError(`the centre (${e}, ${n}) in "${name}" could not be converted to EPSG:2056; ${FIX}`);
  warnings.push(
    `the model's CRS "${name}" (EPSG:${t.epsg ?? '?'}) is not EPSG:2056; only the centre point was reprojected (datum shift: ${t.datumShift}), ` +
      'the model itself must still be placed by its own georeferencing',
  );
  const toLv95 = (x: number, y: number) => {
    const g = t.toWgs84([x, y]);
    const q = g ? target.fromWgs84([g[0], g[1]]) : null;
    return q ? { x: q[0], y: q[1] } : null;
  };
  return { ...base, toLv95, conversionOrigin: { x: p[0], y: p[1] }, centre: { x: p[0], y: p[1] }, crs: { name, matched: 'reprojected', epsg: t.epsg, datumShift: t.datumShift } };
}
