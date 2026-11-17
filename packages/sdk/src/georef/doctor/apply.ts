/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.georef.fix(plan)`: apply the plan's `ready` fixes. A plan may have been
 * edited or built by hand, so the safety rules are checked again here: only
 * `ready` fixes, each with a complete write and no checker caveat. The
 * georeferencing fixes are merged into one write and the site fixes into
 * another; the site write is validated before the first write is made, so a
 * refusal leaves the session as it was.
 */

import { GeoreferencingError, type GeorefSiteInput, type GeorefSiteWriteResult, type GeoreferencingSetInput, type GeoreferencingUpdateInput, type GeoreferencingWriteRequest, type GeoreferencingWriteResult } from '../types.js';
import type { GeorefFixPlan, GeorefFixResult, GeorefPlannedFix, GeorefPlannedWrite } from './types.js';

export interface FixTarget {
  write(request: GeoreferencingWriteRequest): GeoreferencingWriteResult;
  writeSite(input: GeorefSiteInput): GeorefSiteWriteResult;
  /** Throws what `writeSite` would, without writing. */
  validateSite(input: GeorefSiteInput): void;
}

function complete(write: GeorefPlannedWrite): boolean {
  const values = write.via === 'georef.site'
    ? Object.values(write.input)
    : [...Object.values(write.input.ProjectedCRS ?? {}), ...Object.values(write.input.MapConversion ?? {})];
  return values.every((v) => v !== null && v !== undefined);
}

function refuse(fix: GeorefPlannedFix, why: string): never {
  throw new GeoreferencingError('INVALID_INPUT', `Fix ${fix.id} cannot be applied: ${why}. Nothing was written.`);
}

/** Merge `from` into `into`, refusing a field set twice to different values. */
function merge<T extends Record<string, unknown>>(into: T, from: T, fix: GeorefPlannedFix, group: string): void {
  for (const [k, v] of Object.entries(from)) {
    if (into[k] !== undefined && into[k] !== v) refuse(fix, `${group}.${k} is set to ${String(into[k])} by another fix and ${String(v)} by this one`);
    (into as Record<string, unknown>)[k] = v;
  }
}

export function applyGeorefFixPlan(target: FixTarget, plan: GeorefFixPlan): GeorefFixResult {
  const ready = plan.fixes.filter((f) => f.status === 'ready');
  let via: 'georef.set' | 'georef.update' | null = null;
  const crs: Record<string, string> = {};
  const mc: Record<string, number> = {};
  let site: GeorefSiteInput | null = null;
  for (const fix of ready) {
    if (!fix.write) refuse(fix, 'it has no write');
    if (fix.caveat) refuse(fix, 'the checker marks it uncertain');
    if (!complete(fix.write)) refuse(fix, 'a value only the user can supply is still open');
    const write = fix.write;
    if (write.via === 'georef.site') {
      if (site && site.siteId !== write.input.siteId) refuse(fix, 'it writes a different IfcSite than another fix');
      site ??= { ...(write.input.siteId === undefined ? {} : { siteId: write.input.siteId }) };
      const { siteId: _siteId, ...values } = write.input;
      merge(site as Record<string, unknown>, values, fix, 'IfcSite');
      continue;
    }
    for (const key of Object.keys(write.input)) {
      if (key !== 'ProjectedCRS' && key !== 'MapConversion') refuse(fix, `${key} is not supported in a doctor write; use the georeferencing write API directly`);
    }
    if (via && via !== write.via) refuse(fix, `it needs ${write.via} and another fix ${via}`);
    via = write.via;
    merge(crs, (write.input.ProjectedCRS ?? {}) as Record<string, string>, fix, 'ProjectedCRS');
    merge(mc, (write.input.MapConversion ?? {}) as Record<string, number>, fix, 'MapConversion');
  }

  if (site) target.validateSite(site);
  const writes: GeorefFixResult['writes'] = [];
  if (via) {
    const input = { ...(Object.keys(crs).length ? { ProjectedCRS: crs } : {}), ...(Object.keys(mc).length ? { MapConversion: mc } : {}) };
    const result = via === 'georef.set'
      ? target.write({ action: 'set', input: input as unknown as GeoreferencingSetInput })
      : target.write({ action: 'update', input: input as GeoreferencingUpdateInput });
    writes.push({ via, notes: result.notes });
  }
  if (site) {
    target.writeSite(site);
    writes.push({ via: 'georef.site', notes: [] });
  }
  return { applied: ready.map((f) => f.id), writes };
}
