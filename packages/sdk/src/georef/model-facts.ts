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

import { declaresMapConversionScaled } from '@ifc-lite/export';
import { EntityExtractor, parseSourceHeader, type IfcDataStore } from '@ifc-lite/parser';
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
  /** The source FILE_SCHEMA identifier (`IFC4X3_ADD2`, `IFC4X3_RC4`, …), kept verbatim by the exporter. */
  fileSchema: string;
  storage: GeorefStorage | null;
  /**
   * The file's FILE_SCHEMA declares `IfcMapConversionScaled` (IFC4X3 /
   * IFC4X3_ADD2; not the IFC4X3 RCs, IFC4 or earlier). Shared with the
   * exporter's own gate (`declaresMapConversionScaled`).
   */
  supportsScaled: boolean;
  contexts: number[];
  /** ContextType of each context in `contexts` ('' when unset), for messages. */
  contextTypes: Map<number, string>;
  /**
   * The context a new IfcMapConversion is written for: the exporter's own
   * choice (`findPreferredGeometricRepresentationContextId`): the 3D 'Model'
   * context, else the first 3D one, else the first.
   */
  preferredContext: number | null;
  sites: number[];
  /** `sourceCrs`: the conversion's SourceCRS reference (a representation context). */
  mapConversions: Array<{ id: number; scaled: boolean; sourceCrs: number | null }>;
  rigidOperations: number[];
  projectedCRS: number[];
  geographicCRS: number[];
  /** `IfcWellKnownText` records and the CRS each one defines. */
  wellKnownText: Array<{ id: number; crs: number | null }>;
  /** IfcSites with RefLatitude and RefLongitude set. */
  sitesWithLatLong: number[];
  /** IFC2X3 only: the convention sets, when present (the first copy of each). */
  ePSetMapConversion: EPSetLocation | null;
  ePSetProjectedCRS: EPSetLocation | null;
  /** IFC2X3 only: every copy of either set, on any host (the reader reads any of them). */
  ePSets: EPSetLocation[];
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
  const contexts = live('IFCGEOMETRICREPRESENTATIONCONTEXT');
  const contextTypes = new Map<number, string>();
  let model3d: number | null = null;
  let first3d: number | null = null;
  for (const id of contexts) {
    const attrs = attributes(id);
    const type = typeof attrs[1] === 'string' ? attrs[1] : '';
    contextTypes.set(id, type);
    if (attrs[2] === 3) {
      first3d ??= id;
      if (model3d === null && type.trim().toUpperCase() === 'MODEL') model3d = id;
    }
  }
  const sourceCrsOf = (id: number): number | null => {
    const ref = attributes(id)[0];
    return typeof ref === 'number' ? ref : null;
  };
  const header = store.sourceHeader ?? (store.source?.length ? parseSourceHeader(store.source) : undefined);
  const fileSchema = header?.schemaIdentifiers?.[0] || schema;
  const facts: GeorefModelFacts = {
    schema,
    fileSchema,
    storage: storageForSchema(schema),
    supportsScaled: schema === 'IFC4X3' && declaresMapConversionScaled(fileSchema),
    contexts,
    contextTypes,
    preferredContext: model3d ?? first3d ?? contexts[0] ?? null,
    sites,
    mapConversions: [
      ...live('IFCMAPCONVERSION').map((id) => ({ id, scaled: false, sourceCrs: sourceCrsOf(id) })),
      ...live('IFCMAPCONVERSIONSCALED').map((id) => ({ id, scaled: true, sourceCrs: sourceCrsOf(id) })),
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
    ePSets: [],
  };

  if (facts.storage === 'propertySets' && overlay) {
    // The convention sets hang off IfcSite in practice; IfcProject and
    // IfcBuilding are searched too so an edit never misses one and then
    // writes a second, contradicting copy.
    const hosts = [...sites, ...live('IFCPROJECT'), ...live('IFCBUILDING')];
    const mc = findEPSets(overlay, hosts, EPSET_MAP_CONVERSION);
    const crs = findEPSets(overlay, hosts, EPSET_PROJECTED_CRS);
    facts.ePSetMapConversion = mc[0] ?? null;
    facts.ePSetProjectedCRS = crs[0] ?? null;
    facts.ePSets = [...mc, ...crs];
  }
  return facts;
}

function findEPSets(overlay: GeorefOverlayReader, hosts: number[], name: string): EPSetLocation[] {
  const wanted = name.toLowerCase();
  const found: EPSetLocation[] = [];
  for (const hostId of new Set(hosts)) {
    for (const pset of overlay.getForEntity(hostId)) {
      if (pset.name.toLowerCase() !== wanted) continue;
      const values: Record<string, unknown> = {};
      for (const prop of pset.properties) values[prop.name] = prop.value;
      found.push({ hostId, name: pset.name, values });
    }
  }
  return found;
}

/** `#12, #40` for messages. */
export function idList(ids: readonly number[]): string {
  return ids.map((id) => `#${id}`).join(', ');
}
