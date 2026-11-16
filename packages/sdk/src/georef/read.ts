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

/** Every raw STEP type the extractor reads georeferencing from. */
const GEOREF_RECORD_TYPES = Object.freeze(['IFCMAPCONVERSION', 'IFCMAPCONVERSIONSCALED', 'IFCRIGIDOPERATION', 'IFCPROJECTEDCRS', 'IFCGEOGRAPHICCRS', 'IFCWELLKNOWNTEXT']);

/**
 * The georeferencing the model's source bytes declare (no session writes).
 * `isDeleted` is the session's mutation view: a georeferencing record it has
 * deleted is not reported, exactly as the export will not contain it.
 */
export function readSourceGeoreferencing(store: IfcDataStore, modelId: string, isDeleted?: (expressId: number) => boolean): GeoreferencingState {
  const schema = String(store.schemaVersion ?? '');
  const info = extractGeoreferencingOnDemand(isDeleted ? withoutDeletedGeorefRecords(store, isDeleted) : store);
  const state = emptyGeoreferencingState(modelId, schema);
  if (!info) return state;
  return fromGeoreferenceInfo(state, info, store);
}

/**
 * `store`, or a view of it whose type index omits deleted georeferencing
 * records, for the extractor to read. Built only when something was deleted;
 * the extractor memoizes per store object, so a fresh view reads afresh.
 */
function withoutDeletedGeorefRecords(store: IfcDataStore, isDeleted: (expressId: number) => boolean): IfcDataStore {
  if (!store.entityIndex) return store;
  // @raw-entity-enumeration-ok source ids of the georeferencing classes, filtered by the session's tombstones
  const { byType } = store.entityIndex;
  // IFC2X3 keeps its georeferencing in IfcPropertySet records, and the IfcSite RefLatitude/RefLongitude
  // fallback reads IfcSite records: `bim.store.removeEntity` can delete all of them.
  const touched = [...GEOREF_RECORD_TYPES, 'IFCPROPERTYSET', 'IFCSITE'].filter((t) => (byType.get(t) ?? []).some(isDeleted));
  if (touched.length === 0) return store;
  const filtered = new Map(byType);
  for (const t of touched) filtered.set(t, (byType.get(t) ?? []).filter((id) => !isDeleted(id)));
  const view = Object.create(store) as IfcDataStore;
  Object.defineProperty(view, 'georeferencing', { value: undefined, enumerable: true });
  Object.defineProperty(view, 'entityIndex', { value: { ...store.entityIndex, byType: filtered }, enumerable: true });
  return view;
}

/**
 * What the reader reports once every georeferencing record (and, for
 * IFC2X3, every convention set) is gone: the IfcSite RefLatitude/RefLongitude fallback, or nothing.
 * The state `remove` leaves, so `get()` agrees with the exported file.
 */
export function readWithoutGeoreferencing(store: IfcDataStore, modelId: string, withPropertySets: boolean, isDeleted?: (expressId: number) => boolean): GeoreferencingState {
  const schema = String(store.schemaVersion ?? '');
  if (!store.entityIndex) return emptyGeoreferencingState(modelId, schema);
  // The IfcSite fallback is what is left to read, so a site the session deleted must not count.
  const live = isDeleted ? withoutDeletedGeorefRecords(store, isDeleted) : store;
  // @raw-entity-enumeration-ok `live` already omits deleted IfcSites; the georeferencing classes (and convention sets) are dropped wholesale below
  const byType = new Map(live.entityIndex.byType);
  for (const t of withPropertySets ? [...GEOREF_RECORD_TYPES, 'IFCPROPERTYSET'] : GEOREF_RECORD_TYPES) byType.delete(t);
  const view = Object.create(store) as IfcDataStore;
  Object.defineProperty(view, 'georeferencing', { value: undefined, enumerable: true });
  Object.defineProperty(view, 'entityIndex', { value: { ...store.entityIndex, byType }, enumerable: true });
  const info = extractGeoreferencingOnDemand(view);
  const state = emptyGeoreferencingState(modelId, schema);
  return info ? fromGeoreferenceInfo(state, info, store) : state;
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
      mapUnitResolved: crs.mapUnit === undefined ? undefined : crs.mapUnitResolved !== false,
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
