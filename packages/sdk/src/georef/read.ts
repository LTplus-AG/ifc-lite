/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The read half of `bim.georef`: `@ifc-lite/parser`'s extractor result
 * (`GeoreferenceInfo`, frozen camelCase) restated in the SDK shape. No second
 * reader — every value comes from `extractGeoreferencingOnDemand`.
 */

import { extractGeoreferencingOnDemand, type GeoreferenceInfo, type IfcDataStore } from '@ifc-lite/parser';
import { storageForSchema } from './model-facts.js';
import { degreesOf } from './validate.js';
import type {
  GeorefMapConversionState,
  GeorefProjectedCRSState,
  GeorefSource,
  GeoreferencingState,
} from './types.js';

/** An empty state for `modelId`, as for a model with no georeferencing at all. */
export function emptyGeoreferencingState(modelId: string, schema: string): GeoreferencingState {
  return {
    modelId,
    schema,
    hasGeoreference: false,
    source: null,
    storage: storageForSchema(schema),
    ProjectedCRS: null,
    MapConversion: null,
    RigidOperation: null,
    site: null,
    rotationDegrees: null,
    pending: false,
  };
}

/** Rotation in degrees, or null when the vector is not stored. */
export function rotationOf(mc: { XAxisAbscissa?: number; XAxisOrdinate?: number } | null): number | null {
  if (!mc || mc.XAxisAbscissa === undefined || mc.XAxisOrdinate === undefined) return null;
  return degreesOf(mc.XAxisAbscissa, mc.XAxisOrdinate);
}

/** Drop `undefined` members so a JSON dump and a deep-equal both see only what is set. */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The georeferencing a parsed model's source declares, in the `bim.georef`
 * shape — for callers holding a store but no session (`ifc-lite georef show`,
 * `ifc-lite info`). A session's unsaved writes are only visible through
 * `bim.georef.get()`.
 */
export function readGeoreferencing(store: IfcDataStore, modelId = 'model'): GeoreferencingState {
  return readSourceGeoreferencing(store, modelId);
}

/** The georeferencing the model's source bytes declare (no session edits). */
export function readSourceGeoreferencing(store: IfcDataStore, modelId: string): GeoreferencingState {
  const schema = String(store.schemaVersion ?? '');
  const info = extractGeoreferencingOnDemand(store);
  const state = emptyGeoreferencingState(modelId, schema);
  if (!info) return state;
  return fromGeoreferenceInfo(state, info, store);
}

function sourceOf(info: GeoreferenceInfo, store: IfcDataStore): GeorefSource | null {
  switch (info.source) {
    case 'mapConversion': {
      const id = info.mapConversion?.id;
      // @raw-entity-enumeration-ok membership test of one source id against its class
      const scaled = id !== undefined && (store.entityIndex.byType.get('IFCMAPCONVERSIONSCALED') ?? []).includes(id);
      return scaled ? 'IfcMapConversionScaled' : 'IfcMapConversion';
    }
    case 'rigidOperation': return 'IfcRigidOperation';
    case 'ePSetMapConversion': return 'ePSet_MapConversion';
    case 'siteLocation': return 'IfcSite';
    default: return null;
  }
}

function fromGeoreferenceInfo(state: GeoreferencingState, info: GeoreferenceInfo, store: IfcDataStore): GeoreferencingState {
  const source = sourceOf(info, store);
  const mc = info.mapConversion;
  const crs = info.projectedCRS;
  state.hasGeoreference = info.hasGeoreference;
  state.source = source;

  if (source === 'IfcSite' && mc) {
    // The legacy IfcSite RefLatitude/RefLongitude fallback: the extractor
    // packs it into a MapConversion/ProjectedCRS pair, which it is not.
    state.site = { expressId: mc.id, latitude: mc.northings, longitude: mc.eastings, elevation: mc.orthogonalHeight };
    return state;
  }

  if (crs) {
    const type: GeorefProjectedCRSState['type'] = crs.kind === 'geographic'
      ? 'IfcGeographicCRS'
      : source === 'ePSet_MapConversion' ? 'ePSet_ProjectedCRS' : 'IfcProjectedCRS';
    state.ProjectedCRS = compact({
      type,
      expressId: crs.id,
      Name: crs.name,
      Description: crs.description,
      GeodeticDatum: crs.geodeticDatum,
      VerticalDatum: crs.verticalDatum,
      MapProjection: crs.mapProjection,
      MapZone: crs.mapZone,
      MapUnit: crs.mapUnit,
      wellKnownText: crs.wellKnownText,
    });
  }

  if (mc && source === 'IfcRigidOperation') {
    state.RigidOperation = {
      type: 'IfcRigidOperation',
      expressId: mc.id,
      FirstCoordinate: mc.eastings,
      SecondCoordinate: mc.northings,
      Height: mc.orthogonalHeight,
    };
  } else if (mc && source) {
    const type = source as GeorefMapConversionState['type'];
    state.MapConversion = compact({
      type,
      expressId: mc.id,
      Eastings: mc.eastings,
      Northings: mc.northings,
      OrthogonalHeight: mc.orthogonalHeight,
      XAxisAbscissa: mc.xAxisAbscissa,
      XAxisOrdinate: mc.xAxisOrdinate,
      Scale: mc.scale,
      FactorX: mc.factorX,
      FactorY: mc.factorY,
      FactorZ: mc.factorZ,
    });
    state.rotationDegrees = rotationOf(state.MapConversion);
  }
  return state;
}
