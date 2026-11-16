/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.georef.planFixes(report, options)`: turn a check report into the
 * writes that would fix it, and say for every other fix why it is not one
 * of them. Pure: it reads the report only.
 *
 * Safety rules (also enforced again by `fix()`):
 * - only fixes whose checker `apply` statement routes them through the
 *   georeferencing write API (`georef.update`, `georef.set`, `georef.site`);
 * - no value only the user can supply is left open: such a fix waits for
 *   `values`, and the plan lists the paths;
 * - a fix the checker marks uncertain (a `caveat`, "what to check after
 *   applying it, when the fix cannot be certain") is never applied;
 * - per finding, its preferred (first) fix, unless `choose` names another;
 * - a site position the plan derived, or the checker computed through the
 *   reprojector, is used only from a plausible map conversion (see
 *   `site-derivation.ts`);
 * - two fixes that would set one field to different values: the later one
 *   is a conflict and is not applied.
 */

import type { CrsFact, FixApplication, GeorefFacts, GeorefFinding, OperationFact, SuggestedFix } from '@ifc-lite/georef-check';
import { derivationUsable } from './site-derivation.js';
import type { GeorefCheckReport, GeorefFixPlan, GeorefFixPlanOptions, GeorefPlannedFix, GeorefPlannedWrite } from './types.js';

type Values = Readonly<Record<string, string | number>>;
type Write = Exclude<FixApplication, { via: 'manual' }>;

const CRS_KEY: Record<string, keyof CrsFact> = {
  Name: 'name', Description: 'description', GeodeticDatum: 'geodeticDatum', VerticalDatum: 'verticalDatum',
  MapProjection: 'mapProjection', MapZone: 'mapZone', MapUnit: 'mapUnit',
};
const MC_KEY: Record<string, keyof OperationFact> = {
  Eastings: 'eastings', Northings: 'northings', OrthogonalHeight: 'orthogonalHeight', XAxisAbscissa: 'xAxisAbscissa',
  XAxisOrdinate: 'xAxisOrdinate', Scale: 'scale', FactorX: 'factorX', FactorY: 'factorY', FactorZ: 'factorZ',
};

/** The georeferencing the write API addresses: the checker's winner rule (IFC4 entities that claim it, else the ePSets). */
function effective(facts: GeorefFacts, report: GeorefCheckReport): { op?: OperationFact; crs?: CrsFact } {
  if (report.effectiveSource === 'ePSet_MapConversion' || (!facts.entities && facts.ePSet)) return { op: facts.ePSet?.operation, crs: facts.ePSet?.crs };
  return { op: facts.entities?.operation, crs: facts.entities?.crs };
}

function currentValue(path: string, facts: GeorefFacts, report: GeorefCheckReport): string | number | undefined {
  const [group, attr] = path.split('.');
  const { op, crs } = effective(facts, report);
  if (group === 'ProjectedCRS' && crs) return crs[CRS_KEY[attr]] as string | undefined;
  if (group === 'MapConversion' && op) return op[MC_KEY[attr]] as number | undefined;
  if (group === 'IfcSite' && facts.siteLocation) {
    return attr === 'RefLatitude' ? facts.siteLocation.latitude : attr === 'RefLongitude' ? facts.siteLocation.longitude : facts.siteLocation.elevation;
  }
  return undefined;
}

function suppliedValue(path: string, values: Values): string | number | undefined {
  const v: unknown = values[path];
  if ((typeof v !== 'string' && typeof v !== 'number') || (typeof v === 'string' && !v.trim()) || (typeof v === 'number' && !Number.isFinite(v))) return undefined;
  if (path.startsWith('ProjectedCRS.')) return String(v);
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface Built {
  write: GeorefPlannedWrite;
  needs: string[];
  derived?: Record<string, number>;
  /** The site values came from the reprojector (checker or plan), so the plausibility gate applies. */
  reprojected: boolean;
}

/** The write with supplied (and, for a site, derived) values filled in; `needs` lists what is still open. */
function buildWrite(apply: Write, report: GeorefCheckReport, options: GeorefFixPlanOptions): Built {
  const values = options.values ?? {};
  const needs: string[] = [];
  if (apply.via === 'georef.site') {
    const input = { ...apply.input };
    let reprojected = false;
    const derived: Record<string, number> = {};
    for (const attr of ['RefLatitude', 'RefLongitude', 'RefElevation'] as const) {
      if (input[attr] === undefined) continue;
      if (input[attr] !== null) {
        if (attr !== 'RefElevation') reprojected = true;
        continue;
      }
      const supplied = suppliedValue(`IfcSite.${attr}`, values);
      if (supplied !== undefined) input[attr] = supplied as number;
    }
    const d = report.siteDerivation;
    if ((input.RefLatitude === null || input.RefLongitude === null) && d.latitude !== undefined && d.longitude !== undefined) {
      if (input.RefLatitude === null) input.RefLatitude = derived.RefLatitude = d.latitude;
      if (input.RefLongitude === null) input.RefLongitude = derived.RefLongitude = d.longitude;
      reprojected = true;
      // With a derived position, the elevation too, but only where the CRS states its vertical datum.
      if (d.elevation !== undefined && input.RefElevation === undefined) input.RefElevation = derived.RefElevation = d.elevation;
    }
    for (const attr of ['RefLatitude', 'RefLongitude', 'RefElevation'] as const) if (input[attr] === null) needs.push(`IfcSite.${attr}`);
    const { siteId, ...rest } = input;
    const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null && v !== undefined));
    return {
      write: { via: 'georef.site', input: { ...(siteId === undefined ? {} : { siteId }), ...clean } },
      needs,
      reprojected,
      ...(Object.keys(derived).length ? { derived } : {}),
    };
  }
  const crs: Record<string, string> = {};
  const mc: Record<string, number> = {};
  const fill = (group: 'ProjectedCRS' | 'MapConversion', key: string, v: string | number | null) => {
    const path = `${group}.${key}`;
    const value = v ?? suppliedValue(path, values);
    if (value === undefined) needs.push(path);
    else if (group === 'ProjectedCRS') crs[key] = String(value);
    else mc[key] = Number(value);
  };
  for (const [k, v] of Object.entries(apply.input.ProjectedCRS ?? {})) fill('ProjectedCRS', k, v);
  for (const [k, v] of Object.entries(apply.input.MapConversion ?? {})) fill('MapConversion', k, v);
  // The write API never assumes a map unit: a new CRS, or one without a
  // MapUnit, needs it stated (`decideMapUnit` / `planUpdate`).
  const { crs: current } = effective(report.facts, report);
  if (crs.MapUnit === undefined && !needs.includes('ProjectedCRS.MapUnit') && (apply.via === 'georef.set' || !current?.mapUnit)) {
    fill('ProjectedCRS', 'MapUnit', null);
  }
  const input = { ...(Object.keys(crs).length ? { ProjectedCRS: crs } : {}), ...(Object.keys(mc).length ? { MapConversion: mc } : {}) };
  const write = apply.via === 'georef.set'
    ? { via: 'georef.set' as const, input: input as unknown as Extract<GeorefPlannedWrite, { via: 'georef.set' }>['input'] }
    : { via: 'georef.update' as const, input };
  return { write, needs, reprojected: false };
}

/** Field paths a write sets, with their values, for conflict detection. */
function fieldsOf(write: GeorefPlannedWrite): Map<string, string | number> {
  const out = new Map<string, string | number>();
  if (write.via === 'georef.site') {
    for (const [k, v] of Object.entries(write.input)) if (k !== 'siteId' && typeof v === 'number') out.set(`IfcSite.${k}`, v);
    return out;
  }
  for (const [k, v] of Object.entries(write.input.ProjectedCRS ?? {})) if (v !== undefined) out.set(`ProjectedCRS.${k}`, v);
  for (const [k, v] of Object.entries(write.input.MapConversion ?? {})) if (v !== undefined) out.set(`MapConversion.${k}`, v);
  return out;
}

/** Agree exactly, as applyGeorefFixPlan merges writes. */
function same(a: string | number, b: string | number): boolean { return a === b; }

function idsFor(findings: readonly GeorefFinding[]): string[][] {
  const seen = new Map<string, number>();
  return findings.map((f) => {
    const n = (seen.get(f.code) ?? 0) + 1;
    seen.set(f.code, n);
    const prefix = n === 1 ? f.code : `${f.code}#${n}`;
    return f.fixes.map((_, k) => `${prefix}.${k + 1}`);
  });
}

function classify(id: string, finding: GeorefFinding, fix: SuggestedFix, report: GeorefCheckReport, options: GeorefFixPlanOptions): GeorefPlannedFix {
  const base: GeorefPlannedFix = {
    id, code: finding.code, severity: finding.severity, summary: fix.summary, changes: fix.changes, status: 'manual', reason: '',
    ...(fix.caveat ? { caveat: fix.caveat } : {}),
  };
  if (fix.apply.via === 'manual') return { ...base, status: 'manual', reason: fix.apply.reason };
  const built = buildWrite(fix.apply, report, options);
  const withWrite: GeorefPlannedFix = { ...base, write: built.write, ...(built.derived ? { derived: built.derived } : {}) };
  if (fix.caveat) return { ...withWrite, status: 'review', reason: `The checker marks this fix uncertain, so it is never applied automatically: ${fix.caveat}` };
  if (built.needs.length > 0) {
    return {
      ...withWrite,
      status: 'needs-value',
      reason: `Only you can supply ${built.needs.join(', ')}.`,
      needs: built.needs.map((path) => {
        const current = currentValue(path, report.facts, report);
        return current === undefined ? { path } : { path, current };
      }),
    };
  }
  const suppliedSite = built.write.via === 'georef.site' && !built.reprojected;
  if (built.write.via === 'georef.site' && !suppliedSite && !derivationUsable(report.siteDerivation, options.acceptApproximateDatum === true)) {
    const blockers = report.siteDerivation.blockedBy.filter((b) => !(b.reason === 'approximateDatum' && options.acceptApproximateDatum));
    return {
      ...withWrite,
      status: 'review',
      reason: `This site position comes from the map conversion, which cannot be relied on here: ${blockers.map((b) => b.detail).join(' ')}${blockers.some((b) => b.reason === 'approximateDatum') ? ' Accept the approximate datum shift explicitly, or supply the values.' : ''}`,
    };
  }
  return { ...withWrite, status: 'ready', reason: built.derived ? `Derived from the map conversion through EPSG:${report.siteDerivation.epsg} (datum shift ${report.siteDerivation.datumShift}).` : 'Goes through the georeferencing write API with every value known.' };
}

export function planGeorefFixes(report: GeorefCheckReport, options: GeorefFixPlanOptions = {}): GeorefFixPlan {
  const chosen = new Set(options.choose ?? []);
  const ids = idsFor(report.findings);
  const known = new Set(ids.flat());
  const unknown = [...chosen].filter((id) => !known.has(id));
  if (unknown.length > 0) throw new RangeError(`Unknown fix id${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (this report has: ${[...known].join(', ') || 'none'}).`);

  const fixes: GeorefPlannedFix[] = [];
  report.findings.forEach((finding, fi) => {
    const pickedHere = finding.fixes.some((_, k) => chosen.has(ids[fi][k]));
    finding.fixes.forEach((fix, k) => {
      const planned = classify(ids[fi][k], finding, fix, report, options);
      const preferred = pickedHere ? chosen.has(planned.id) : k === 0;
      const instead = pickedHere ? [...chosen].find((c) => ids[fi].includes(c)) : ids[fi][0];
      if (!preferred && planned.status === 'ready') {
        fixes.push({ ...planned, status: 'alternative', alternativeTo: instead, reason: `An alternative to ${instead}; choose it by id to apply it instead.` });
      } else {
        fixes.push(preferred || !instead ? planned : { ...planned, alternativeTo: instead });
      }
    });
  });

  // Conflicts and the set/update split, in report order (most severe first).
  const claimed = new Map<string, { id: string; value: string | number }>();
  let georefVia: 'georef.set' | 'georef.update' | null = null;
  for (const fix of fixes) {
    if (fix.status !== 'ready' || !fix.write) continue;
    if (fix.write.via !== 'georef.site') {
      if (georefVia && georefVia !== fix.write.via) {
        Object.assign(fix, { status: 'conflict', reason: `It needs ${fix.write.via}, but an earlier fix already uses ${georefVia}; apply it in a second pass.` });
        continue;
      }
    }
    const clash = [...fieldsOf(fix.write)].find(([path, value]) => claimed.has(path) && !same(claimed.get(path)!.value, value));
    if (clash) {
      const [path, value] = clash;
      const other = claimed.get(path)!;
      Object.assign(fix, { status: 'conflict', reason: `It sets ${path} to ${value}, but ${other.id} sets it to ${other.value}.` });
      continue;
    }
    if (fix.write.via !== 'georef.site') georefVia = fix.write.via;
    for (const [path, value] of fieldsOf(fix.write)) if (!claimed.has(path)) claimed.set(path, { id: fix.id, value });
  }
  // A derived site value describes the original conversion, not a conversion another fix changes.
  const changesConversion = fixes.some((f) => f.status === 'ready' && f.write && f.write.via !== 'georef.site'
    && Object.entries(f.write.input.MapConversion ?? {}).some(([key, value]) => currentValue(`MapConversion.${key}`, report.facts, report) !== value));
  if (changesConversion) for (const f of fixes) {
    if (f.status === 'ready' && f.write?.via === 'georef.site' && f.derived) {
      f.status = 'review';
      f.reason = 'Recheck after applying the map conversion fix: these derived site values describe the previous conversion.';
    }
  }
  return { fixes };
}
