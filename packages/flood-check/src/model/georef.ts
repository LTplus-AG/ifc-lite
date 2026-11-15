/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Local engineering coordinates to map metres, from the model's own
 * IfcMapConversion (or IFC2X3 ePSet_MapConversion / IfcRigidOperation), using
 * the parser's transform helpers. No reprojection: the model must already be
 * in the provider's projected CRS.
 *
 * Refuses (never guesses) when: there is no map conversion; the target CRS is
 * geographic or cannot be pinned to an EPSG code; it is not the expected CRS;
 * or the conversion's Scale is ambiguous. That last case is a file whose
 * project length unit differs from the map unit while Scale is unset or 1:
 * read by the letter of the schema it is a 1000x scale for a millimetre
 * project, read by authoring-tool habit it is 1. Both readings exist in the
 * wild, so the caller has to pick with `mapScale`.
 */

import {
  computeTransformMatrix,
  extractGeoreferencingOnDemand,
  transformToWorld,
  type GeoreferenceInfo,
  type IfcDataStore,
  type MapConversion,
} from '@ifc-lite/parser';
import { FloodCheckRefusal } from '../errors.js';
import { projectedCrsConflict, projectedCrsIdentifier, sameCrs } from '../crs.js';
import type { Vec3 } from './placement.js';

export interface GeoreferenceOptions {
  /** Refuse unless the model's CRS is this one (for example the provider's). */
  expectedCrs?: string;
  /**
   * How to read an ambiguous Scale (see module docs). Default `'refuse'`.
   * `'schema'`: Scale as written (1 when unset). `'unit-bridged'`: Scale is
   * taken as the unit ratio, so local values in the project unit land in map
   * metres unscaled.
   */
  mapScale?: 'refuse' | 'schema' | 'unit-bridged';
}

/** What the check knows about the model's georeferencing, and how it maps points. */
export interface ModelGeoreference {
  /** Normalised target CRS, for example `EPSG:2056`. */
  crs: string;
  /** The vertical datum the model states (IfcProjectedCRS.VerticalDatum), verbatim; null when not stated. */
  verticalDatum: string | null;
  source: NonNullable<GeoreferenceInfo['source']>;
  /** Map position of the local origin, metres. */
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  /** Counter-clockwise angle from map east to local X, degrees. */
  rotationDegrees: number;
  /** Local raw unit → map metres, horizontally. */
  horizontalScale: number;
  /** How the scale was decided. */
  scaleBasis: 'units-agree' | 'explicit-scale' | 'schema' | 'unit-bridged';
  /** Project length unit in metres. */
  lengthUnitScale: number;
  /** Map raw local coordinates (file length unit) to map metres `[E, N, H]`. */
  toMap(local: Vec3): Vec3;
}

const EPS = 1e-9;

export function resolveModelGeoreference(store: IfcDataStore, options: GeoreferenceOptions = {}): ModelGeoreference {
  const info = extractGeoreferencingOnDemand(store);
  if (!info?.hasGeoreference || !info.mapConversion || info.source === 'siteLocation') {
    throw new FloodCheckRefusal(
      'not-georeferenced',
      info?.source === 'siteLocation'
        ? 'the model carries only IfcSite latitude/longitude, no map conversion into a projected CRS'
        : 'the model has no IfcMapConversion (or ePSet_MapConversion) into a projected CRS',
    );
  }
  const crsInfo = info.projectedCRS;
  if (!crsInfo) throw new FloodCheckRefusal('crs-unrecognised', 'the map conversion names no target CRS');
  if (crsInfo.kind === 'geographic') {
    throw new FloodCheckRefusal('geographic-crs', `the target CRS ${crsInfo.name || '(unnamed)'} is geographic, not projected`);
  }
  const conflict = projectedCrsConflict(crsInfo);
  if (conflict) {
    throw new FloodCheckRefusal(
      'crs-mismatch',
      `the target CRS is named ${conflict.name} but its WKT identifies ${conflict.wkt}; which one the coordinates are in cannot be told, so the model is not checked`,
    );
  }
  const crs = projectedCrsIdentifier(crsInfo);
  if (!crs) {
    throw new FloodCheckRefusal(
      'crs-unrecognised',
      `the target CRS "${crsInfo.name}" cannot be identified as an EPSG code from its name, WKT or description`,
    );
  }
  if (options.expectedCrs && !sameCrs(crs, options.expectedCrs)) {
    throw new FloodCheckRefusal('crs-mismatch', `the model is georeferenced in ${crs}; ${options.expectedCrs} is required`);
  }

  const conversion: MapConversion = info.mapConversion;
  const lus = store.lengthUnitScale && store.lengthUnitScale > 0 ? store.lengthUnitScale : 1;
  // IFC: an absent MapUnit means the project length unit applies.
  const mus = crsInfo.mapUnitScale && crsInfo.mapUnitScale > 0 ? crsInfo.mapUnitScale : lus;
  const rawScale = conversion.scale;
  // The transform reads a zero Scale as 1, and a negative or non-finite one is no georeference.
  if (rawScale !== undefined && !(Number.isFinite(rawScale) && rawScale > 0)) {
    throw new FloodCheckRefusal('georeference-implausible', `IfcMapConversion.Scale is ${rawScale}, not a positive number; the model cannot be placed`);
  }
  const scaleUnset = rawScale === undefined || Math.abs(rawScale - 1) < EPS;
  const unitsDiffer = Math.abs(mus - lus) > EPS * Math.max(mus, lus);
  // IfcMapConversionScaled factors (projection distortion) stay in the matrix as written;
  // only the unit-bearing Scale is decided here.

  let scale = rawScale ?? 1;
  let scaleBasis: ModelGeoreference['scaleBasis'];
  if (!unitsDiffer) {
    scaleBasis = scaleUnset ? 'units-agree' : 'explicit-scale';
  } else if (!scaleUnset) {
    scaleBasis = 'explicit-scale';
  } else {
    const mode = options.mapScale ?? 'refuse';
    if (mode === 'refuse') {
      throw new FloodCheckRefusal(
        'ambiguous-map-scale',
        `the project length unit (${lus} m) differs from the map unit (${mus} m) and IfcMapConversion.Scale is ${rawScale === undefined ? 'unset' : '1'}; ` +
          `pass mapScale 'schema' or 'unit-bridged' to say which reading the file follows`,
      );
    }
    if (mode === 'unit-bridged') scale = lus / mus;
    scaleBasis = mode;
  }

  const matrix = computeTransformMatrix({ ...conversion, scale });
  const georef: GeoreferenceInfo = { hasGeoreference: true, mapConversion: conversion, transformMatrix: matrix };
  const angle = conversion.xAxisAbscissa !== undefined && conversion.xAxisOrdinate !== undefined
    ? Math.atan2(conversion.xAxisOrdinate, conversion.xAxisAbscissa) * (180 / Math.PI)
    : 0;
  return {
    crs,
    verticalDatum: crsInfo.verticalDatum ?? null,
    source: info.source ?? 'mapConversion',
    eastings: conversion.eastings * mus,
    northings: conversion.northings * mus,
    orthogonalHeight: conversion.orthogonalHeight * mus,
    rotationDegrees: angle,
    horizontalScale: scale * mus * (conversion.factorX ?? 1),
    scaleBasis,
    lengthUnitScale: lus,
    toMap(local: Vec3): Vec3 {
      const w = transformToWorld(local, georef);
      if (!w) throw new Error('georeference transform is not invertible');
      return [w[0] * mus, w[1] * mus, w[2] * mus];
    },
  };
}

/** The plain-data part of a {@link ModelGeoreference}, without the transform closure. */
export function georeferenceData(g: ModelGeoreference): Omit<ModelGeoreference, 'toMap'> {
  return {
    crs: g.crs,
    verticalDatum: g.verticalDatum,
    source: g.source,
    eastings: g.eastings,
    northings: g.northings,
    orthogonalHeight: g.orthogonalHeight,
    rotationDegrees: g.rotationDegrees,
    horizontalScale: g.horizontalScale,
    scaleBasis: g.scaleBasis,
    lengthUnitScale: g.lengthUnitScale,
  };
}
