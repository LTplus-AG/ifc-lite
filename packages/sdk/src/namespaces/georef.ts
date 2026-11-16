/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BimBackend } from '../types.js';
import type {
  GeorefCheckOptions,
  GeorefCheckReport,
  GeorefFixPlan,
  GeorefFixPlanOptions,
  GeorefFixResult,
  GeorefSiteInput,
  GeorefSiteWriteResult,
  GeoreferencingSetInput,
  GeoreferencingState,
  GeoreferencingUpdateInput,
  GeoreferencingWriteResult,
} from '../georef/types.js';
import { planGeorefFixes } from '../georef/doctor/plan.js';

/**
 * `bim.georef` — read and write a model's georeferencing.
 *
 * IFC4 and IFC4X3 write `IfcProjectedCRS` + `IfcMapConversion` (IFC4X3:
 * `IfcMapConversionScaled` when FactorX/Y/Z are given); IFC2X3 writes the
 * `ePSet_MapConversion` / `ePSet_ProjectedCRS` property sets the readers
 * already understand. Writes are held in the session and land in the file
 * with the next `bim.export.ifc()`.
 *
 * Writes fail closed and throw a `GeoreferencingError` naming the missing
 * input: no CRS, map unit, scale or factor is ever assumed; a model without
 * a representation context (IFC2X3: without an IfcSite) is refused; an
 * existing georeferencing is replaced only with `replace: true`; and values
 * that would contradict each other (an angle and a vector that disagree, a
 * CRS renamed while keeping the old datum) are refused.
 *
 * Needs direct store access: the headless CLI and MCP contexts implement it;
 * other backends throw.
 *
 * @example
 * bim.georef.set({
 *   ProjectedCRS: { Name: 'EPSG:2056', GeodeticDatum: 'CH1903+', MapUnit: 'METRE' },
 *   MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
 *   rotationDegrees: 12.5,
 * });
 * const ifc = bim.export.ifc(undefined, {}); // carries the georeferencing
 */
export class GeorefNamespace {
  constructor(private backend: BimBackend) {}

  private impl() {
    if (!this.backend.georef) {
      throw new Error(
        'georef: not available on this backend — georeferencing writes need ' +
        'direct store access (use a headless context, not a remote transport).',
      );
    }
    return this.backend.georef;
  }

  /** The model's georeferencing, including this session's unsaved writes. */
  get(modelId?: string): GeoreferencingState {
    return this.impl().get(modelId);
  }

  /** Write a complete georeferencing. Throws when one exists unless `replace: true`. */
  set(input: GeoreferencingSetInput, modelId?: string): GeoreferencingWriteResult {
    return this.impl().write({ action: 'set', input }, modelId);
  }

  /** Change single values of the existing georeferencing. */
  update(input: GeoreferencingUpdateInput, modelId?: string): GeoreferencingWriteResult {
    return this.impl().write({ action: 'update', input }, modelId);
  }

  /** Remove the georeferencing (map conversions, CRSs, IFC2X3 ePSets). */
  remove(modelId?: string): GeoreferencingWriteResult {
    return this.impl().write({ action: 'remove' }, modelId);
  }

  /**
   * Write IfcSite RefLatitude / RefLongitude (decimal degrees, WGS84) and
   * RefElevation (project length units). One undo step.
   *
   * @example
   * bim.georef.setSite({ RefLatitude: 46.94809, RefLongitude: 7.44744, RefElevation: 540 });
   */
  setSite(input: GeorefSiteInput, modelId?: string): GeorefSiteWriteResult {
    const impl = this.impl();
    if (!impl.writeSite) throw new Error('georef.setSite: not available on this backend.');
    return impl.writeSite(input, modelId);
  }

  /**
   * Diagnose the georeferencing (`@ifc-lite/georef-check`) with the EPSG
   * catalogue and CRS engine wired in. Offline unless `allowNetwork`; the
   * checks a missing capability prevented are in `skipped`. A session with
   * unsaved edits is checked as it would be exported.
   *
   * @example
   * const report = await bim.georef.check();
   * const plan = bim.georef.planFixes(report);
   * bim.georef.fix(plan); // the `ready` fixes only
   */
  check(options: GeorefCheckOptions = {}, modelId?: string): Promise<GeorefCheckReport> {
    const impl = this.impl();
    if (!impl.check) throw new Error('georef.check: not available on this backend.');
    return impl.check(options, modelId);
  }

  /** Which of a report's fixes can be applied, which need a value, and why the rest cannot. Pure. */
  planFixes(report: GeorefCheckReport, options: GeorefFixPlanOptions = {}): GeorefFixPlan {
    return planGeorefFixes(report, options);
  }

  /** Apply a plan's `ready` fixes (re-checked: write API only, nothing user-supplied left open, no checker caveat). */
  fix(plan: GeorefFixPlan, modelId?: string): GeorefFixResult {
    const impl = this.impl();
    if (!impl.fix) throw new Error('georef.fix: not available on this backend.');
    return impl.fix(plan, modelId);
  }
}
