/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The user's standing LandXML georeferencing assumptions (viewer settings):
 * the ones every federated LandXML load uses unless the load names its own
 * (`ModelLoadOptions.landXmlAssumptions`, e.g. the refusal prompt's retry).
 *
 * A cross-file preference persisted to localStorage, workspace-wide, NOT per
 * file, so it is deliberately absent from the loading slice's teardown (like
 * `unitDisplayOverrides`). Default: every assumption off, which is the
 * fail-closed behaviour of #5048.
 */

import {
  NO_LANDXML_GEOREF_ASSUMPTIONS,
  type LandXmlGeorefAssumptions,
} from '../../hooks/ingest/landXmlGeorefAssumptions.js';

export const LANDXML_GEOREF_ASSUMPTIONS_STORAGE_KEY = 'ifclite.landxml.georef-assumptions.v1';

/**
 * Reads a stored value field by field: only an explicit `true` turns an
 * assumption on, so a malformed or partial entry can never enable one.
 */
export function parseLandXmlGeorefAssumptionSettings(raw: unknown): LandXmlGeorefAssumptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_LANDXML_GEOREF_ASSUMPTIONS;
  const value = raw as Record<string, unknown>;
  return {
    sharedVerticalDatum: value.sharedVerticalDatum === true,
    epsgFromName: value.epsgFromName === true,
  };
}

export function loadLandXmlGeorefAssumptionSettings(): LandXmlGeorefAssumptions {
  try {
    if (typeof localStorage === 'undefined') return NO_LANDXML_GEOREF_ASSUMPTIONS;
    const stored = localStorage.getItem(LANDXML_GEOREF_ASSUMPTIONS_STORAGE_KEY);
    if (!stored) return NO_LANDXML_GEOREF_ASSUMPTIONS;
    return parseLandXmlGeorefAssumptionSettings(JSON.parse(stored));
  } catch (err) {
    console.warn(`[landxml] failed to load ${LANDXML_GEOREF_ASSUMPTIONS_STORAGE_KEY}`, err);
    return NO_LANDXML_GEOREF_ASSUMPTIONS;
  }
}

export function saveLandXmlGeorefAssumptionSettings(settings: LandXmlGeorefAssumptions): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LANDXML_GEOREF_ASSUMPTIONS_STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    // Quota exceeded / private mode: the settings stay in memory for this session.
    console.warn(`[landxml] failed to persist ${LANDXML_GEOREF_ASSUMPTIONS_STORAGE_KEY}`, err);
  }
}
