/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.georef.setSite`: IfcSite RefLatitude / RefLongitude / RefElevation.
 *
 * The values go in as decimal degrees (WGS84, as IFC defines them) and
 * RefElevation in project length units; the latitude and longitude are
 * written as `IfcCompoundPlaneAngleMeasure` (see `site-angle.ts`). The three
 * attributes are positions 9, 10 and 11 of IfcSite in IFC2X3, IFC4 and
 * IFC4X3 alike, and are written as positional attribute edits, which the
 * exporter serializes per slot (an integer list, a REAL). A write is
 * planned in full before anything changes and recorded as one compound
 * mutation, so a refusal changes nothing and one undo takes it back.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { fromCompoundPlaneAngle, toCompoundPlaneAngle } from './site-angle.js';
import { rejectUnknownKeys, requireNumber } from './validate.js';
import { GeoreferencingError, type GeorefSiteInput, type GeorefSiteWriteResult, type GeoreferencingState } from './types.js';

/** Zero-based IfcSite attribute positions (IFC2X3, IFC4, IFC4X3). */
export const SITE_SLOTS = { RefLatitude: 9, RefLongitude: 10, RefElevation: 11 } as const;
type SiteAttribute = keyof typeof SITE_SLOTS;
const SITE_KEYS = ['siteId', 'RefLatitude', 'RefLongitude', 'RefElevation'] as const;
const SITE_SCHEMAS = new Set(['IFC2X3', 'IFC4', 'IFC4X3']);

/** What one site write sets, by slot, ready for `setPositionalAttribute`. */
export interface SiteWritePlan {
  siteId: number;
  edits: Array<[slot: number, value: number[] | { real: number }]>;
  result: GeorefSiteWriteResult;
}

type SiteValues = Record<SiteAttribute, number | null>;

function liveSites(store: IfcDataStore, view: MutablePropertyView | null): number[] {
  // @raw-entity-enumeration-ok source IfcSite ids minus this session's tombstones (sites are not overlay-created here)
  return (store.entityIndex.byType.get('IFCSITE') ?? []).filter((id) => !view?.isDeleted(id));
}

/** The site's RefLatitude/RefLongitude (decimal degrees) and RefElevation, this session's edits included. */
export function readSiteValues(store: IfcDataStore, view: MutablePropertyView | null, siteId: number): SiteValues {
  // @raw-entity-enumeration-ok point read of one source IfcSite record
  const ref = store.entityIndex.byId.get(siteId);
  const attributes = (ref && store.source?.length ? new EntityExtractor(store.source).extractEntity(ref)?.attributes : undefined) ?? [];
  const edits = view?.getPositionalMutationsForEntity(siteId) ?? null;
  const at = (slot: number): unknown => {
    if (edits?.has(slot)) {
      const v = edits.get(slot);
      return v !== null && typeof v === 'object' && !Array.isArray(v) && 'real' in v ? v.real : v;
    }
    return attributes[slot];
  };
  const elevation = at(SITE_SLOTS.RefElevation);
  return {
    RefLatitude: fromCompoundPlaneAngle(at(SITE_SLOTS.RefLatitude)) ?? null,
    RefLongitude: fromCompoundPlaneAngle(at(SITE_SLOTS.RefLongitude)) ?? null,
    RefElevation: typeof elevation === 'number' && Number.isFinite(elevation) ? elevation : null,
  };
}

function chooseSite(store: IfcDataStore, view: MutablePropertyView | null, siteId: number | undefined): number {
  const sites = liveSites(store, view);
  if (siteId !== undefined) {
    if (!Number.isSafeInteger(siteId) || !sites.includes(siteId)) {
      throw new GeoreferencingError('INVALID_INPUT', `siteId #${siteId} is not an IfcSite of this model (IfcSites: ${sites.map((s) => `#${s}`).join(', ') || 'none'}).`, ['siteId']);
    }
    return siteId;
  }
  if (sites.length === 0) throw new GeoreferencingError('NO_ANCHOR', 'The model has no IfcSite to carry RefLatitude/RefLongitude. Nothing was written.', ['IfcSite']);
  if (sites.length > 1) {
    throw new GeoreferencingError('AMBIGUOUS', `The model has ${sites.length} IfcSites (${sites.map((s) => `#${s}`).join(', ')}); pass siteId. Nothing was written.`, ['siteId']);
  }
  return sites[0];
}

/**
 * Validate a site write and plan it, or refuse with the missing input named.
 * `ownedEdits` are the ids of the earlier site edits the caller made and can
 * carry; `'all'` is for a host whose own undo history holds every edit of the
 * view (the viewer), so an earlier location edit is read as it stands.
 */
export function planSiteWrite(store: IfcDataStore, view: MutablePropertyView | null, input: GeorefSiteInput, ownedEdits: ReadonlySet<string> | 'all' = new Set()): SiteWritePlan {
  rejectUnknownKeys(input, SITE_KEYS, '');
  if (!input) throw new GeoreferencingError('INVALID_INPUT', 'setSite needs an input object.');
  const schema = String(store.schemaVersion ?? '');
  if (!SITE_SCHEMAS.has(schema)) {
    throw new GeoreferencingError('UNSUPPORTED_SCHEMA', `IfcSite RefLatitude/RefLongitude can be written to IFC2X3, IFC4 and IFC4X3 models; this model is ${schema || 'of unknown schema'}.`);
  }
  const given = (['RefLatitude', 'RefLongitude', 'RefElevation'] as const).filter((k) => input[k] !== undefined);
  if (given.length === 0) {
    throw new GeoreferencingError('MISSING_INPUT', 'setSite was given nothing to write: pass RefLatitude and RefLongitude (decimal degrees) and/or RefElevation.', ['RefLatitude', 'RefLongitude']);
  }
  const values: Partial<SiteValues> = {};
  for (const key of given) values[key] = requireNumber(input[key], key);
  if (values.RefLatitude !== undefined && values.RefLatitude !== null && Math.abs(values.RefLatitude) > 90) {
    throw new GeoreferencingError('INVALID_INPUT', `RefLatitude must be within -90..90 degrees, got ${values.RefLatitude}.`, ['RefLatitude']);
  }
  if (values.RefLongitude !== undefined && values.RefLongitude !== null && Math.abs(values.RefLongitude) > 180) {
    throw new GeoreferencingError('INVALID_INPUT', `RefLongitude must be within -180..180 degrees, got ${values.RefLongitude}.`, ['RefLongitude']);
  }
  const siteId = chooseSite(store, view, input.siteId);
  const changes = view?.getEffectiveChanges() ?? [];
  if (changes.some((c) => (c.kind === 'type' && (liveSites(store, view).includes(c.entityId) || c.newValue?.toUpperCase() === 'IFCSITE'))
    || (c.kind === 'entity-added' && c.newValue?.toUpperCase() === 'IFCSITE')
    || (c.entityId === siteId && c.kind === 'attribute' && (Object.keys(SITE_SLOTS) as string[]).includes(c.name ?? '')))) {
    throw new GeoreferencingError('UNSUPPORTED_RECORD', 'IfcSite was created, retyped or its location edited outside setSite; its current values cannot be carried reliably. Nothing was written.');
  }
  if (ownedEdits !== 'all') {
    const history = view?.getMutations() ?? [];
    for (const slot of Object.values(SITE_SLOTS)) {
      const value = view?.getPositionalMutationsForEntity(siteId)?.get(slot);
      if (value === undefined) continue;
      const latest = [...history].reverse().find((m) => m.type === 'UPDATE_POSITIONAL_ATTRIBUTE' && m.entityId === siteId && m.attributeName === `@${slot}`);
      if (!latest || !ownedEdits.has(latest.id) || JSON.stringify(latest.newValue) !== JSON.stringify(value)) {
        throw new GeoreferencingError('UNSUPPORTED_RECORD', `IfcSite location slot ${slot} was edited outside setSite. Nothing was written.`);
      }
    }
  }
  const before = readSiteValues(store, view, siteId);
  const after: SiteValues = { ...before, ...values };
  // One without the other locates nothing, and readers drop it.
  if ((after.RefLatitude === null) !== (after.RefLongitude === null)) {
    const missing = after.RefLatitude === null ? 'RefLatitude' : 'RefLongitude';
    throw new GeoreferencingError('MISSING_INPUT', `IfcSite #${siteId} would have ${missing === 'RefLatitude' ? 'RefLongitude' : 'RefLatitude'} without ${missing}; pass both. Nothing was written.`, [missing]);
  }
  const edits: SiteWritePlan['edits'] = [];
  const written: GeorefSiteWriteResult['written'] = {};
  for (const key of given) {
    const v = values[key] as number;
    if (key === 'RefElevation') {
      edits.push([SITE_SLOTS.RefElevation, { real: v }]);
      written.RefElevation = v;
    } else {
      const angle = toCompoundPlaneAngle(v);
      edits.push([SITE_SLOTS[key], angle]);
      written[key] = angle;
    }
  }
  return { siteId, edits, result: { siteId, before, after, written } };
}

/**
 * `state` with this session's site edits applied, where the reader would
 * report the site: when it is the georeferencing source, or when nothing
 * else is and the edited site now has a latitude and longitude.
 */
export function withSiteEdits(state: GeoreferencingState, store: IfcDataStore, view: MutablePropertyView | null): GeoreferencingState {
  if (!view) return state;
  if (state.hasGeoreference && state.source !== 'IfcSite') return state;
  const sites = liveSites(store, view);
  if (!sites.some((id) => view.getPositionalMutationsForEntity(id)?.size)) return state;
  for (const target of sites) {
    const v = readSiteValues(store, view, target);
    if (v.RefLatitude === null || v.RefLongitude === null) continue;
    return {
      ...state,
      hasGeoreference: true,
      source: 'IfcSite',
      site: { expressId: target, latitude: v.RefLatitude, longitude: v.RefLongitude, elevation: v.RefElevation ?? 0 },
    };
  }
  return state;
}
