/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * {@link GeorefFacts} from a parsed `IfcDataStore`: every georeferencing
 * source (via the parser's candidates reader), the units, and the coordinate
 * magnitudes read straight from the STEP entities.
 *
 * Reads the file as authored. A caller holding georeference edits (the write
 * API) applies them to the returned facts before diagnosing.
 */

import {
  EntityExtractor,
  extractGeoreferenceCandidatesOnDemand,
  type GeoreferenceInfo,
  type IfcDataStore,
  type MapConversion,
  type ProjectedCRS,
} from '@ifc-lite/parser';
import { coordinateMagnitudes, hasPostalAddress, modelContextFacts, type EntityReader } from './coordinates.js';
import type { CrsFact, GeorefFacts, GeoreferenceSourceFact, OperationFact } from './types.js';

export interface CollectGeorefFactsOptions {
  /** Coordinate tuples to sample for {@link CoordinateMagnitudes.pointMedian}; default 2048. */
  maxSampledPoints?: number;
}

function operationFact(conversion: MapConversion, source: OperationFact['source']): OperationFact {
  const fact: OperationFact = {
    source,
    entityId: conversion.id,
    eastings: conversion.eastings,
    northings: conversion.northings,
    orthogonalHeight: conversion.orthogonalHeight,
  };
  if (conversion.xAxisAbscissa !== undefined) fact.xAxisAbscissa = conversion.xAxisAbscissa;
  if (conversion.xAxisOrdinate !== undefined) fact.xAxisOrdinate = conversion.xAxisOrdinate;
  if (conversion.scale !== undefined) fact.scale = conversion.scale;
  if (conversion.factorX !== undefined) fact.factorX = conversion.factorX;
  if (conversion.factorY !== undefined) fact.factorY = conversion.factorY;
  if (conversion.factorZ !== undefined) fact.factorZ = conversion.factorZ;
  return fact;
}

function crsFact(crs: ProjectedCRS, source: CrsFact['source']): CrsFact {
  const fact: CrsFact = { source, entityId: crs.id, name: crs.name };
  for (const key of ['description', 'geodeticDatum', 'verticalDatum', 'mapProjection', 'mapZone', 'mapUnit', 'wellKnownText'] as const) {
    const value = crs[key];
    if (value !== undefined) fact[key] = value;
  }
  if (crs.mapUnitScale !== undefined) fact.mapUnitScale = crs.mapUnitScale;
  return fact;
}

function entitySource(info: GeoreferenceInfo): GeoreferenceSourceFact | undefined {
  const out: GeoreferenceSourceFact = {};
  if (info.mapConversion) {
    out.operation = operationFact(info.mapConversion, info.mapConversion.operation === 'rigidOperation' ? 'IfcRigidOperation' : 'IfcMapConversion');
  }
  if (info.projectedCRS) out.crs = crsFact(info.projectedCRS, info.projectedCRS.kind === 'geographic' ? 'IfcGeographicCRS' : 'IfcProjectedCRS');
  return out.operation || out.crs ? out : undefined;
}

function ePSetSource(info: GeoreferenceInfo | null): GeoreferenceSourceFact | undefined {
  if (!info) return undefined;
  const out: GeoreferenceSourceFact = {};
  if (info.mapConversion) out.operation = operationFact(info.mapConversion, 'ePSet_MapConversion');
  if (info.projectedCRS) out.crs = crsFact(info.projectedCRS, 'ePSet_ProjectedCRS');
  return out.operation || out.crs ? out : undefined;
}

/** A cached {@link EntityReader} over the store's STEP source. */
export function storeEntityReader(store: IfcDataStore): EntityReader | null {
  const index = store.entityIndex;
  if (!store.source?.length || !index) return null;
  const extractor = new EntityExtractor(store.source);
  const cache = new Map<number, { type: string; attributes: unknown[] } | null>();
  // @raw-entity-enumeration-ok diagnoses the file as authored; a caller with georeference edits patches the facts instead
  const refOf = (id: number) => index.byId.get(id) ?? store.deferredEntityIndex?.get(id);
  return {
    get(id) {
      let entity = cache.get(id);
      if (entity === undefined) {
        const ref = refOf(id);
        entity = ref ? extractor.extractEntity(ref) : null;
        cache.set(id, entity);
      }
      return entity ?? undefined;
    },
    // @raw-entity-enumeration-ok reads the authored STEP records the georeference lives in, not the live (edited) table
    idsOfType: (type) => index.byType.get(type) ?? [],
    sizeOf: (id) => refOf(id)?.byteLength,
  };
}

/**
 * Collect the facts {@link diagnoseGeoreference} reads. Null for a store with
 * no STEP source (IFCX / tabular stores carry no IFC georeferencing entities).
 */
export function collectGeorefFacts(store: IfcDataStore, options: CollectGeorefFactsOptions = {}): GeorefFacts | null {
  const reader = storeEntityReader(store);
  const candidates = extractGeoreferenceCandidatesOnDemand(store);
  if (!reader || !candidates) return null;

  const facts: GeorefFacts = {
    schemaVersion: store.schemaVersion,
    lengthUnitScale: store.lengthUnitScale ?? 1,
    lengthUnitDeclared: store.lengthUnitSource === 'declared',
  };
  const entities = entitySource(candidates.entities);
  if (entities) facts.entities = entities;
  const ePSet = ePSetSource(candidates.ePSetMapConversion);
  if (ePSet) facts.ePSet = ePSet;
  if (candidates.mapConversions.length > 1) {
    facts.additionalMapConversions = candidates.mapConversions.map((c) => operationFact(c, 'IfcMapConversion'));
  }
  const site = candidates.siteLocation?.mapConversion;
  if (site) {
    // The parser's legacy-site reading stores longitude/latitude/elevation in the conversion's slots.
    facts.siteLocation = { siteId: site.id, latitude: site.northings, longitude: site.eastings, elevation: site.orthogonalHeight };
  }
  if (hasPostalAddress(reader)) facts.hasPostalAddress = true;
  Object.assign(facts, modelContextFacts(reader));
  const siteId = site?.id ?? reader.idsOfType('IFCSITE')[0];
  facts.coordinates = coordinateMagnitudes(reader, siteId, options.maxSampledPoints);
  return facts;
}
