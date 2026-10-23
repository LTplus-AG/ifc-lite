/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Explicit, user-chosen relaxations of the fail-closed CRS rules (#5048) for
 * federating a LandXML onto a georeferenced model. Both are OFF by default:
 * a LandXML that cannot be aligned is still refused, and the refusal names
 * the missing declarations (#7605). The user can opt in per load (the
 * refusal's retry) or always (viewer settings), and every model placed
 * under an assumption says so.
 *
 * Mirrors #5175's `assumedLinearUnit`: never inferred, only applied when the
 * user chose it.
 */

/** The assumptions, each one a separate choice. */
export interface LandXmlGeorefAssumptions {
  /**
   * When the LandXML and/or the anchor declares no vertical datum, treat both
   * as using the same height system (heights placed as authored) instead of
   * refusing. Resolved through `resolveSpatialPlacement`'s existing
   * `unknownVertical: 'assume-compatible'` option.
   */
  readonly sharedVerticalDatum: boolean;
  /**
   * When `CoordinateSystem` declares no `epsgCode` and no `EPSG:<n>`
   * `horizontalDatum`, read an exact `EPSG:<n>` `CoordinateSystem@name` as the
   * horizontal CRS. A name that is not exactly `EPSG:<digits>` is never read.
   */
  readonly epsgFromName: boolean;
}

export type LandXmlGeorefAssumption = keyof LandXmlGeorefAssumptions;

export const NO_LANDXML_GEOREF_ASSUMPTIONS: LandXmlGeorefAssumptions = Object.freeze({
  sharedVerticalDatum: false,
  epsgFromName: false,
});

/**
 * A federated LandXML that could not be aligned. `offer` lists exactly the
 * assumptions that would make it align (empty when none would, e.g. a CRS
 * mismatch or a surface that is genuinely too far away). It is the COMPLETE
 * set for the retry, including any this load already applied and still needs,
 * and it is non-empty only when at least one of them was not applied: a retry
 * with exactly `offer` enabled is the alignment it describes. Ordered as
 * `LANDXML_GEOREF_ASSUMPTION_ORDER`.
 */
export class LandXmlFederationRefusedError extends Error {
  constructor(message: string, readonly offer: readonly LandXmlGeorefAssumption[]) {
    super(message);
    this.name = 'LandXmlFederationRefusedError';
  }
}

/** What the refusal prompt needs: the reason, the offer, and a retry with the user's choice. */
export interface LandXmlAssumptionRefusal {
  readonly fileName: string;
  readonly message: string;
  readonly offer: readonly LandXmlGeorefAssumption[];
  readonly retry: (assumptions: LandXmlGeorefAssumptions) => void;
}

/** Canonical order of the assumptions in an offer or an applied list. */
export const LANDXML_GEOREF_ASSUMPTION_ORDER: readonly LandXmlGeorefAssumption[] = ['epsgFromName', 'sharedVerticalDatum'];

/** The resolver policy `sharedVerticalDatum` selects; absent or off is fail-closed. */
export function unknownVerticalPolicy(
  assumptions: Partial<LandXmlGeorefAssumptions> | undefined,
): 'refuse' | 'assume-compatible' {
  return assumptions?.sharedVerticalDatum === true ? 'assume-compatible' : 'refuse';
}

/**
 * The prompt state for a failed load, or null when the failure is not a
 * refused federation that some assumption would fix. `retry` receives the
 * complete set of assumptions for the new attempt.
 */
export function landXmlAssumptionRefusalFrom(
  error: unknown,
  fileName: string,
  retry: (assumptions: LandXmlGeorefAssumptions) => void,
): LandXmlAssumptionRefusal | null {
  if (!(error instanceof LandXmlFederationRefusedError) || error.offer.length === 0) return null;
  return { fileName, message: error.message, offer: error.offer, retry };
}
