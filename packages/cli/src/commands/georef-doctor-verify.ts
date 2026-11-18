/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { stat } from 'node:fs/promises';
import type { IfcDataStore } from '@ifc-lite/parser';
import { collectGeorefFacts } from '@ifc-lite/georef-check';
import type { GeorefFixPlan } from '@ifc-lite/sdk';
import { GeorefUsageError } from './georef-args.js';

/** Resolve symlinks and hard links through filesystem identity before opening the output for writing. */
export async function assertDistinctOutput(input: string, output: string): Promise<void> {
  let destination;
  try { destination = await stat(output); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const source = await stat(input);
  if (source.dev === destination.dev && source.ino === destination.ino) {
    throw new GeorefUsageError('georef fix never overwrites its input: --out points to the input file');
  }
}

/** Verify all site fields, including elevation, from the bytes that would be saved. */
export function verifySiteWrites(store: IfcDataStore, plan: GeorefFixPlan): string[] {
  const writes = plan.fixes.filter((f) => f.status === 'ready' && f.write?.via === 'georef.site');
  if (writes.length === 0) return [];
  const site = collectGeorefFacts(store)?.siteLocation;
  const mismatches: string[] = [];
  for (const fix of writes) {
    if (fix.write?.via !== 'georef.site') continue;
    const input = fix.write.input;
    if (!site || (input.siteId !== undefined && input.siteId !== site.siteId)) {
      mismatches.push(`IfcSite #${input.siteId ?? '?'} cannot be read back`);
      continue;
    }
    for (const [key, got] of [['RefLatitude', site.latitude], ['RefLongitude', site.longitude], ['RefElevation', site.elevation]] as const) {
      const want = input[key];
      if (want !== undefined && (got === undefined || !Number.isFinite(got) || Math.abs(want - got) > 1e-6)) {
        mismatches.push(`IfcSite.${key}: expected ${want}, read ${got}`);
      }
    }
  }
  return mismatches;
}
