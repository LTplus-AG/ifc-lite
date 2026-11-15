/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Human rendering and write-back verification for `ifc-lite georef`. */

import type { GeoreferenceInfo } from '@ifc-lite/parser';
import type { GeoreferencingState } from '@ifc-lite/sdk';

const CRS_KEYS = ['Name', 'Description', 'GeodeticDatum', 'VerticalDatum', 'MapProjection', 'MapZone', 'MapUnit'] as const;
const MC_KEYS = ['Eastings', 'Northings', 'OrthogonalHeight', 'XAxisAbscissa', 'XAxisOrdinate', 'Scale', 'FactorX', 'FactorY', 'FactorZ'] as const;

function ref(type: string, id: number | undefined): string {
  return id === undefined ? `${type} (new)` : `${type} #${id}`;
}

/** One line for `ifc-lite info`. */
export function georeferencingSummary(state: GeoreferencingState): string {
  if (state.RigidOperation) return `${state.ProjectedCRS?.Name || 'no CRS'} via IfcRigidOperation #${state.RigidOperation.expressId}`;
  if (state.MapConversion || state.ProjectedCRS) {
    const crs = state.ProjectedCRS ? `${state.ProjectedCRS.Name || '(unnamed CRS)'}${state.ProjectedCRS.MapUnit ? `, ${state.ProjectedCRS.MapUnit}` : ''}` : 'no CRS';
    const mc = state.MapConversion;
    const at = mc ? ` at E ${mc.Eastings} N ${mc.Northings} H ${mc.OrthogonalHeight}` : '';
    return `${crs}${at} (${state.source ?? state.ProjectedCRS?.type})`;
  }
  if (state.site) return `IfcSite location only (lat ${state.site.latitude}, lon ${state.site.longitude})`;
  return 'none';
}

export function describeGeoreferencing(state: GeoreferencingState): string {
  const lines = [`  Schema:   ${state.schema}`];
  if (!state.hasGeoreference) {
    lines.push('  Georeferencing: none');
    return lines.join('\n') + '\n';
  }
  const crs = state.ProjectedCRS;
  const mc = state.MapConversion;
  const op = mc ? ref(mc.type, mc.expressId) : state.RigidOperation ? ref('IfcRigidOperation', state.RigidOperation.expressId) : null;
  lines.push(`  Source:   ${[op, crs ? ref(crs.type, crs.expressId) : null].filter(Boolean).join(' -> ') || state.source}`);
  if (crs) {
    lines.push(`  CRS:      ${crs.Name || '(no Name)'}${crs.Description ? ` — ${crs.Description}` : ''}`);
    for (const key of CRS_KEYS.slice(2)) {
      lines.push(`    ${key.padEnd(15)} ${crs[key] ?? '(not set)'}`);
    }
    if (crs.wellKnownText) lines.push(`    WellKnownText   ${crs.wellKnownText.slice(0, 60)}${crs.wellKnownText.length > 60 ? '…' : ''}`);
  }
  if (mc) {
    lines.push('  Map conversion:');
    for (const key of MC_KEYS) {
      if (mc[key] !== undefined) lines.push(`    ${key.padEnd(17)} ${mc[key]}`);
    }
    lines.push(`    Rotation          ${state.rotationDegrees === null ? 'none stored' : `${Number(state.rotationDegrees.toPrecision(12))}°`}`);
  }
  if (state.RigidOperation) {
    const r = state.RigidOperation;
    lines.push(`  Rigid operation:  FirstCoordinate ${r.FirstCoordinate}, SecondCoordinate ${r.SecondCoordinate}, Height ${r.Height}`);
  }
  if (state.site) {
    lines.push(`  IfcSite #${state.site.expressId}: latitude ${state.site.latitude}, longitude ${state.site.longitude}, elevation ${state.site.elevation}`);
  }
  return lines.join('\n') + '\n';
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Differences between what a write meant and what the written bytes read
 * back as. An empty list is the only answer that lets the CLI save the file.
 */
export function verifyWritten(intended: GeoreferencingState, reread: GeoreferencingState, info: GeoreferenceInfo | null): string[] {
  const out: string[] = [];
  if (!info) return ['the written file could not be read back'];
  const want = intended.ProjectedCRS;
  const got = reread.ProjectedCRS;
  if (!want && !intended.MapConversion) {
    if (reread.MapConversion || reread.ProjectedCRS || reread.RigidOperation) out.push('georeferencing is still present after remove');
    return out;
  }
  if (want) {
    if (!got) out.push('no CRS was read back');
    else for (const key of CRS_KEYS) {
      if ((want[key] ?? undefined) !== (got[key] ?? undefined)) out.push(`ProjectedCRS.${key}: wanted ${JSON.stringify(want[key])}, read ${JSON.stringify(got[key])}`);
    }
  }
  const mcWant = intended.MapConversion;
  const mcGot = reread.MapConversion;
  if (mcWant) {
    if (!mcGot) out.push('no map conversion was read back');
    else {
      if (mcWant.type !== mcGot.type) out.push(`map conversion type: wanted ${mcWant.type}, read ${mcGot.type}`);
      for (const key of MC_KEYS) {
        const w = mcWant[key];
        const g = mcGot[key];
        if (w === undefined && g === undefined) continue;
        if (w === undefined || g === undefined || !close(w, g)) out.push(`MapConversion.${key}: wanted ${w}, read ${g}`);
      }
    }
  }
  return out;
}
