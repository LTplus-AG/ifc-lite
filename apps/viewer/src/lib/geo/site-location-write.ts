/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IfcSite RefLatitude / RefLongitude / RefElevation as a viewer session edit
 * (#10659): the georeferencing check's site fixes and the Georeference
 * panel's site rows.
 *
 * The SDK's `planSiteWrite` validates the write (schema IFC2X3 / IFC4 /
 * IFC4X3, the site, ranges, both coordinates) and encodes it exactly as
 * `bim.georef.setSite` does: the angles as IfcCompoundPlaneAngleMeasure
 * (degrees, minutes, seconds, millionths of a second, every component
 * carrying the sign) and RefElevation as a REAL, at IfcSite positions 9, 10
 * and 11. The edits go through `setPositionalAttributesBatch`, so they are
 * one undo step, show in the Properties panel and are serialized by IFC
 * export like any other positional edit. The viewer's undo history holds
 * every edit of the view, so the plan is made with `'all'` owned edits.
 *
 * Imports the SDK's georef-doctor entry: load it only from lazy modules.
 */

import { GeoreferencingError, SITE_SLOTS, planSiteWrite, readSiteValues, type GeorefSiteInput } from '@ifc-lite/sdk/georef-doctor';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';

export type SiteLocationAttribute = keyof typeof SITE_SLOTS;

export type SiteWriteOutcome =
  | { ok: true; siteId: number; batchId: string }
  | { ok: false; code: GeoreferencingError['code'] | 'NOT_EDITABLE'; message: string };

/** Write a site location to `modelId` as one undoable edit (or as part of `batchId`). Refusals change nothing. */
export function writeSiteLocation(modelId: string, input: GeorefSiteInput, batchId?: string): SiteWriteOutcome {
  const state = useViewerStore.getState();
  const store = state.models.get(modelId)?.ifcDataStore;
  if (!store) return { ok: false, code: 'NOT_EDITABLE', message: `No model "${modelId}" is loaded.` };
  let plan: ReturnType<typeof planSiteWrite>;
  try {
    plan = planSiteWrite(store, state.mutationViews.get(modelId) ?? null, input, 'all');
  } catch (error) {
    if (error instanceof GeoreferencingError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
  const written = state.setPositionalAttributesBatch(
    modelId,
    plan.edits.map(([index, value]) => ({ entityId: plan.siteId, index, value })),
    batchId,
  );
  return written
    ? { ok: true, siteId: plan.siteId, batchId: written }
    : { ok: false, code: 'NOT_EDITABLE', message: 'This model cannot be edited.' };
}

export interface SiteLocationRead {
  siteId: number;
  values: Record<SiteLocationAttribute, number | null>;
  /** The attributes this session edited. */
  edited: Record<SiteLocationAttribute, boolean>;
}

/** The location of the model's only live IfcSite, this session's edits included; null with none or several. */
export function readSiteLocation(store: IfcDataStore, view: MutablePropertyView | null): SiteLocationRead | null {
  // @raw-entity-enumeration-ok source IfcSite ids minus this session's tombstones
  const sites = (store.entityIndex.byType.get('IFCSITE') ?? []).filter((id) => !view?.isDeleted(id));
  if (sites.length !== 1) return null;
  const [siteId] = sites;
  const edits = view?.getPositionalMutationsForEntity(siteId);
  const edited = (attr: SiteLocationAttribute): boolean => edits?.has(SITE_SLOTS[attr]) ?? false;
  return {
    siteId,
    values: readSiteValues(store, view, siteId),
    edited: { RefLatitude: edited('RefLatitude'), RefLongitude: edited('RefLongitude'), RefElevation: edited('RefElevation') },
  };
}
