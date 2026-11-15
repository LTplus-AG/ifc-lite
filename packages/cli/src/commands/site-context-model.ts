/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The site centre from a model's georeferencing, read through `bim.georef`'s
 * reader. Only the map conversion's origin is used: the model's rotation and
 * scale belong to placing the model, which the viewer does through its
 * federation spatial reference, never to the site context.
 */

import { resolveCrs, type CrsTransformer } from '@ifc-lite/geo';
import { extractGeoreferencingOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { readGeoreferencing } from '@ifc-lite/sdk';

/** The model cannot give a site centre; the message says how to fix it. */
export class SiteContextModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteContextModelError';
  }
}

const FIX = 'set it with `ifc-lite georef set <model.ifc> --epsg 2056 --map-unit METRE --eastings E --northings N --height H --out F`';

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
  /** Things the user should know that did not stop the run. */
  warnings: string[];
}

const LN02 = /\bLN\s*-?\s*02\b|EPSG:?\s*5728\b/i;

function mapUnitScale(store: IfcDataStore): { scale: number; source: ModelCentre['mapUnitSource'] } {
  const crs = extractGeoreferencingOnDemand(store)?.projectedCRS;
  if (crs?.mapUnitResolved === false) {
    throw new SiteContextModelError(`the model's IfcProjectedCRS.MapUnit could not be read, so the map conversion's units are unknown; ${FIX}`);
  }
  if (crs?.mapUnitScale !== undefined) return { scale: crs.mapUnitScale, source: 'MapUnit' };
  // IFC: without MapUnit, the project's length unit applies.
  return { scale: store.lengthUnitScale ?? 1, source: 'project length unit' };
}

async function lv95(): Promise<CrsTransformer> {
  const t = await resolveCrs({ epsg: 2056 });
  if (!t) throw new Error('@ifc-lite/geo could not resolve EPSG:2056');
  return t;
}

export async function siteCentreFromModel(store: IfcDataStore): Promise<ModelCentre> {
  const state = readGeoreferencing(store);
  const mc = state.MapConversion;
  const crsState = state.ProjectedCRS;
  if (!mc || !crsState) {
    const what = state.source === 'IfcSite'
      ? 'only IfcSite RefLatitude/RefLongitude, no map conversion'
      : state.source === 'IfcRigidOperation' ? 'an IfcRigidOperation, not a map conversion' : 'no map conversion';
    throw new SiteContextModelError(`the model has ${what}; site context needs an IfcMapConversion to EPSG:2056: ${FIX}`);
  }
  const warnings: string[] = [];
  const name = crsState.Name?.trim() ?? '';

  const vertical = crsState.VerticalDatum?.trim() || null;
  if (vertical && !LN02.test(vertical)) {
    throw new SiteContextModelError(
      `the model states vertical datum "${vertical}", but swissALTI3D heights are LN02 (EPSG:5728); refusing to mix height systems. ` +
        'If the model is in fact LN02, correct it with `ifc-lite georef update <model.ifc> --vertical-datum LN02 --out F`',
    );
  }
  if (!vertical) warnings.push('the model states no vertical datum; the site context is in LN02 (EPSG:5728) heights, check the model uses the same');

  const unit = mapUnitScale(store);
  if (unit.source === 'project length unit') warnings.push(`IfcProjectedCRS has no MapUnit; the project length unit (${unit.scale} m) was applied to Eastings/Northings`);
  const e = mc.Eastings * unit.scale;
  const n = mc.Northings * unit.scale;
  const base = { mapUnitToMetres: unit.scale, mapUnitSource: unit.source, verticalDatum: vertical, rotationDegrees: state.rotationDegrees, warnings };

  if (/^EPSG:\s*2056$/i.test(name)) {
    return { ...base, centre: { x: e, y: n }, crs: { name, matched: 'literal', epsg: 2056 } };
  }
  const t = await resolveCrs({ name: name || undefined, wkt: crsState.wellKnownText });
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
  return { ...base, centre: { x: p[0], y: p[1] }, crs: { name, matched: 'reprojected', epsg: t.epsg, datumShift: t.datumShift } };
}
