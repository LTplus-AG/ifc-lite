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
import { parseSourceHeader, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { effectiveEntities } from './effective-entities.js';
import { locateConventionSets } from './epset-locator.js';
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
  /** The host is an IfcSite, IfcProject or IfcBuilding, where the convention puts the sets. */
  managed: boolean;
  /** The session edited or created this copy, so the exported file re-emits it. */
  edited: boolean;
  /** Set when no relationship attaches the set to anything: its own entity id (`hostId` is then 0). */
  orphan?: number;
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
  /** Every context in the planner's order of preference: the preferred one, then the other 3D ones, then the rest. */
  rankedContexts: number[];
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
  /**
   * What the effective view cannot answer reliably (an entity whose attributes the exporter will write but this
   * reader cannot interpret). A write planned from these facts refuses, naming each.
   */
  unknown: string[];
}

export function storageForSchema(schema: string): GeorefStorage | null {
  if (schema === 'IFC2X3') return 'propertySets';
  if (schema === 'IFC4' || schema === 'IFC4X3') return 'entities';
  return null;
}

/**
 * Collect the facts from the session's effective view (`view` is null for a session that has never written):
 * source plus created minus deleted, edits applied where a fact depends on an attribute.
 */
export function collectGeorefModelFacts(store: IfcDataStore, view: MutablePropertyView | null): GeorefModelFacts {
  const schema = String(store.schemaVersion ?? '');
  const effective = effectiveEntities(store, view);
  const unknown: string[] = [];
  const live = (type: string): number[] => effective.idsOf(type);
  const attributes = (id: number): unknown[] => {
    const read = effective.attributesOf(id);
    if ('unknown' in read) { unknown.push(read.unknown); return []; }
    return read.attributes;
  };

  const sites = live('IFCSITE');
  const contexts = live('IFCGEOMETRICREPRESENTATIONCONTEXT');
  const contextTypes = new Map<number, string>();
  // The planner's preference, applied to every candidate: a 3D 'Model' context, then any other 3D one, then the rest
  // (in file order within each tier), so what is left after a later deletion is what a fresh plan would pick.
  const tier = new Map<number, number>();
  for (const id of contexts) {
    const attrs = attributes(id);
    const type = typeof attrs[1] === 'string' ? attrs[1] : '';
    contextTypes.set(id, type);
    if (attrs[2] === 3) {
      tier.set(id, type.trim().toUpperCase() === 'MODEL' ? 0 : 1);
    }
  }
  const ranked = [...contexts].sort((a, b) => (tier.get(a) ?? 2) - (tier.get(b) ?? 2));
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
    preferredContext: ranked[0] ?? null,
    rankedContexts: ranked,
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
    unknown,
  };

  // Every schema: the reader falls back to the convention sets whatever the file's schema, so a writer must know
  // every copy of them, on any host or on none (see `locateConventionSets`).
  if (view) {
    const located = locateConventionSets(store, view, effective, new Set([...sites, ...live('IFCPROJECT'), ...live('IFCBUILDING')]));
    facts.ePSetMapConversion = located.mapConversion;
    facts.ePSetProjectedCRS = located.projectedCRS;
    facts.ePSets = located.copies;
  }
  return facts;
}

/** `#12, #40` for messages. */
export function idList(ids: readonly number[]): string {
  return ids.map((id) => `#${id}`).join(', ');
}
