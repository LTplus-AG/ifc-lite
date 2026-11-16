/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Human rendering of `ifc-lite georef check` / `fix`: the report, and every fix with what it would change or why it cannot. */

import type { GeorefCheckReport, GeorefFixPlan, GeorefPlannedFix } from '@ifc-lite/sdk';

const STATUS_LABEL: Record<GeorefPlannedFix['status'], string> = {
  ready: 'will apply',
  'needs-value': 'needs a value',
  review: 'not applied: review',
  manual: 'manual',
  alternative: 'alternative',
  conflict: 'not applied: conflict',
};

/** `ifc-lite georef update` flag for a write-API path, for the equivalent command of a fix the doctor will not apply. */
const UPDATE_FLAGS: Record<string, string> = {
  'ProjectedCRS.Name': '--crs', 'ProjectedCRS.Description': '--description', 'ProjectedCRS.GeodeticDatum': '--geodetic-datum',
  'ProjectedCRS.VerticalDatum': '--vertical-datum', 'ProjectedCRS.MapProjection': '--map-projection', 'ProjectedCRS.MapZone': '--map-zone',
  'ProjectedCRS.MapUnit': '--map-unit', 'MapConversion.Eastings': '--eastings', 'MapConversion.Northings': '--northings',
  'MapConversion.OrthogonalHeight': '--height', 'MapConversion.XAxisAbscissa': '--x-axis-abscissa', 'MapConversion.XAxisOrdinate': '--x-axis-ordinate',
  'MapConversion.Scale': '--scale', 'MapConversion.FactorX': '--factor-x', 'MapConversion.FactorY': '--factor-y', 'MapConversion.FactorZ': '--factor-z',
};

function quote(v: string | number): string {
  const s = String(v);
  return /^[\w.:+-]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\"'\"'") + "'";
}

/** Path → value pairs of a planned write. */
export function writeFields(fix: GeorefPlannedFix): Array<[string, string | number]> {
  const w = fix.write;
  if (!w) return [];
  if (w.via === 'georef.site') {
    return Object.entries(w.input).filter(([k]) => k !== 'siteId').map(([k, v]) => [`IfcSite.${k}`, v as number]);
  }
  return [
    ...Object.entries(w.input.ProjectedCRS ?? {}).map(([k, v]) => [`ProjectedCRS.${k}`, v as string] as [string, string]),
    ...Object.entries(w.input.MapConversion ?? {}).map(([k, v]) => [`MapConversion.${k}`, v as number] as [string, number]),
  ];
}

function currentOf(report: GeorefCheckReport, path: string): string | number | undefined {
  const facts = report.facts;
  const source = report.effectiveSource === 'ePSet_MapConversion' || (!facts.entities && facts.ePSet) ? facts.ePSet : facts.entities;
  const [group, attr] = path.split('.');
  const key = attr.charAt(0).toLowerCase() + attr.slice(1);
  if (group === 'ProjectedCRS') return (source?.crs as Record<string, unknown> | undefined)?.[key] as string | undefined;
  if (group === 'MapConversion') return (source?.operation as Record<string, unknown> | undefined)?.[key] as number | undefined;
  const site = facts.siteLocation;
  if (!site) return undefined;
  return attr === 'RefLatitude' ? site.latitude : attr === 'RefLongitude' ? site.longitude : site.elevation;
}

function describeFix(fix: GeorefPlannedFix, report: GeorefCheckReport, file: string): string[] {
  const lines = [`      ${fix.id}  [${STATUS_LABEL[fix.status]}]  ${fix.summary}`];
  const indent = '          ';
  if (fix.status === 'ready' || fix.status === 'alternative') {
    for (const [path, value] of writeFields(fix)) {
      const before = currentOf(report, path);
      const tag = fix.derived && path.replace('IfcSite.', '') in fix.derived ? '  (derived)' : '';
      lines.push(`${indent}${path}: ${before === undefined ? '(not set)' : before} -> ${value}${tag}`);
    }
  }
  if (fix.status !== 'ready') lines.push(`${indent}${fix.reason}`);
  if (fix.status === 'needs-value') {
    for (const need of fix.needs ?? []) {
      lines.push(`${indent}supply: --value ${need.path}=<value>${need.current === undefined ? '' : `   (current: ${need.current})`}`);
    }
    if (fix.alternativeTo) lines.push(`${indent}and choose it: --apply ${fix.id}`);
  }
  if (fix.status === 'alternative') lines.push(`${indent}choose it: --apply ${fix.id}`);
  if (fix.status === 'review' && fix.write) {
    const fields = writeFields(fix);
    if (fix.write.via === 'georef.site') {
      lines.push(`${indent}to apply it yourself: ${fields.map(([p, v]) => `--value ${p}=${quote(v)}`).join(' ')}`);
    } else if (fields.every(([p]) => UPDATE_FLAGS[p])) {
      lines.push(`${indent}to apply it yourself: ifc-lite georef update ${quote(file)} --out OUT.ifc ${fields.map(([p, v]) => `${UPDATE_FLAGS[p]} ${quote(v)}`).join(' ')}`);
    }
  }
  return lines;
}

export function describeReport(file: string, report: GeorefCheckReport, plan: GeorefFixPlan): string {
  const count = (s: string) => report.findings.filter((f) => f.severity === s).length;
  const lines = [
    '',
    `  File:     ${file}${report.includesSessionEdits ? ' (with this session\'s edits)' : ''}`,
    `  Schema:   ${report.schemaVersion}`,
    `  Level of georeferencing (LoGeoRef): ${report.level}${report.levels.length > 1 ? ` (present: ${report.levels.join(', ')})` : ''}`,
  ];
  for (const crs of report.capabilities.crs) {
    lines.push(`  CRS:      EPSG:${crs.epsg} ${crs.resolved ? `resolved, datum shift ${crs.datumShift}` : 'not resolved'}${crs.note ? ` — ${crs.note}` : ''}`);
  }
  lines.push(`  Network:  ${report.capabilities.network ? 'allowed' : 'off (--allow-network to fetch EPSG definitions and datum grids)'}`);
  lines.push(`  Findings: ${count('error')} error, ${count('warning')} warning, ${count('info')} info`);
  const byFinding = new Map<string, GeorefPlannedFix[]>();
  for (const fix of plan.fixes) {
    const key = fix.id.slice(0, fix.id.lastIndexOf('.'));
    byFinding.set(key, [...(byFinding.get(key) ?? []), fix]);
  }
  const seen = new Map<string, number>();
  for (const finding of report.findings) {
    const n = (seen.get(finding.code) ?? 0) + 1;
    seen.set(finding.code, n);
    const key = n === 1 ? finding.code : `${finding.code}#${n}`;
    lines.push('', `  ${finding.severity.toUpperCase().padEnd(7)} ${finding.code}`, `      ${finding.message}`);
    const fixes = byFinding.get(key) ?? [];
    if (fixes.length === 0) lines.push('      (no fix: only you can say what is right)');
    for (const fix of fixes) lines.push(...describeFix(fix, report, file));
  }
  if (report.skipped.length > 0) {
    lines.push('', '  Not checked:');
    for (const s of report.skipped) lines.push(`    ${s.code}: ${s.reason}`);
  }
  return lines.join('\n') + '\n';
}
