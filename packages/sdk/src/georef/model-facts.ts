/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a georeferencing write has to know about the model before it may
 * write anything: which coordinate operations and CRSs already exist (after
 * this session's deletions), whether there is a representation context to
 * anchor an `IfcMapConversion` to, and, for IFC2X3, where the
 * `ePSet_MapConversion` / `ePSet_ProjectedCRS` convention sets live.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { GeorefStorage } from './types.js';

/** The two IFC2X3 convention property sets, matched case-insensitively like the reader. */
export const EPSET_MAP_CONVERSION = 'ePSet_MapConversion';
export const EPSET_PROJECTED_CRS = 'ePSet_ProjectedCRS';

/** An IFC2X3 convention set as found on its host. */
export interface EPSetLocation {
  hostId: number;
  /** The set's own spelling in the file (`ePset_…` is common). */
  name: string;
  /** Property name → value, as the mutation view reports it. */
  values: Record<string, unknown>;
}

export interface GeorefModelFacts {
  schema: string;
  storage: GeorefStorage | null;
  /** IFC4X3 declares `IfcMapConversionScaled`; earlier schemas do not. */
  supportsScaled: boolean;
  contexts: number[];
  sites: number[];
  mapConversions: Array<{ id: number; scaled: boolean }>;
  rigidOperations: number[];
  projectedCRS: number[];
  geographicCRS: number[];
  /** `IfcWellKnownText` records and the CRS each one defines. */
  wellKnownText: Array<{ id: number; crs: number | null }>;
  /** IfcSites with RefLatitude and RefLongitude set. */
  sitesWithLatLong: number[];
  /** IFC2X3 only: the convention sets, when present. */
  ePSetMapConversion: EPSetLocation | null;
  ePSetProjectedCRS: EPSetLocation | null;
}

/** The slice of the session's mutation view the facts read. */
export interface GeorefOverlayReader {
  isDeleted(expressId: number): boolean;
  /** Property sets of an entity, base and session edits combined. */
  getForEntity(entityId: number): Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>;
}

export function storageForSchema(schema: string): GeorefStorage | null {
  if (schema === 'IFC2X3') return 'propertySets';
  if (schema === 'IFC4' || schema === 'IFC4X3') return 'entities';
  return null;
}

/** Collect the facts. `overlay` is null for a session that has never written. */
export function collectGeorefModelFacts(store: IfcDataStore, overlay: GeorefOverlayReader | null): GeorefModelFacts {
  const schema = String(store.schemaVersion ?? '');
  // @raw-entity-enumeration-ok source ids of one class, minus this session's tombstones (georef records are never overlay-created)
  const live = (type: string): number[] => (store.entityIndex.byType.get(type) ?? []).filter((id) => !overlay?.isDeleted(id));
  const extractor = store.source?.length ? new EntityExtractor(store.source) : null;
  const attributes = (id: number): unknown[] => {
    // @raw-entity-enumeration-ok point read of one source record selected above
    const ref = store.entityIndex.byId.get(id);
    return (ref && extractor?.extractEntity(ref)?.attributes) || [];
  };

  const sites = live('IFCSITE');
  const facts: GeorefModelFacts = {
    schema,
    storage: storageForSchema(schema),
    supportsScaled: schema === 'IFC4X3',
    contexts: live('IFCGEOMETRICREPRESENTATIONCONTEXT'),
    sites,
    mapConversions: [
      ...live('IFCMAPCONVERSION').map((id) => ({ id, scaled: false })),
      ...live('IFCMAPCONVERSIONSCALED').map((id) => ({ id, scaled: true })),
    ],
    rigidOperations: live('IFCRIGIDOPERATION'),
    projectedCRS: live('IFCPROJECTEDCRS'),
    geographicCRS: live('IFCGEOGRAPHICCRS'),
    wellKnownText: live('IFCWELLKNOWNTEXT').map((id) => {
      const crs = attributes(id)[1];
      return { id, crs: typeof crs === 'number' ? crs : null };
    }),
    // IfcSite: RefLatitude [9], RefLongitude [10] in IFC2X3, IFC4 and IFC4X3.
    sitesWithLatLong: sites.filter((id) => {
      const attrs = attributes(id);
      return Array.isArray(attrs[9]) && Array.isArray(attrs[10]);
    }),
    ePSetMapConversion: null,
    ePSetProjectedCRS: null,
  };

  if (facts.storage === 'propertySets' && overlay) {
    // The convention sets hang off IfcSite in practice; IfcProject and
    // IfcBuilding are searched too so an edit never misses one and then
    // writes a second, contradicting copy.
    const hosts = [...sites, ...live('IFCPROJECT'), ...live('IFCBUILDING')];
    facts.ePSetMapConversion = findEPSet(overlay, hosts, EPSET_MAP_CONVERSION);
    facts.ePSetProjectedCRS = findEPSet(overlay, hosts, EPSET_PROJECTED_CRS);
  }
  return facts;
}

function findEPSet(overlay: GeorefOverlayReader, hosts: number[], name: string): EPSetLocation | null {
  const wanted = name.toLowerCase();
  for (const hostId of hosts) {
    for (const pset of overlay.getForEntity(hostId)) {
      if (pset.name.toLowerCase() !== wanted) continue;
      const values: Record<string, unknown> = {};
      for (const prop of pset.properties) values[prop.name] = prop.value;
      return { hostId, name: pset.name, values };
    }
  }
  return null;
}

/** `#12, #40` for messages. */
export function idList(ids: readonly number[]): string {
  return ids.map((id) => `#${id}`).join(', ');
}
