/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { evidenceJson } from './projection';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const offered = (entry: unknown): boolean =>
  record(entry) && entry.status === 'available' && Array.isArray(entry.expectedJsonParts);

/** #7329: complete Group facts are optional. Reserve ordinary selected rows
 * first by refusing every available Group pin in the summary baseline. */
export function selectionGroupBaseline(summary: unknown): unknown {
  if (!record(summary) || !Array.isArray(summary.nativeGroups) || !summary.nativeGroups.some(offered)) return summary;
  return { ...summary, nativeGroups: summary.nativeGroups.map(entry => offered(entry)
    ? { ...(entry as Record<string, unknown>), status: 'unavailable-transport-budget', expectedJsonParts: null } : entry) };
}

/** Admit each unchanged whole Group pin only when the complete envelope still fits.
 * Returns the summary actually sent; a refused pin stays explicitly unavailable. */
export function admitSelectionGroups(original: unknown, baseline: unknown,
  fits: (summary: unknown) => boolean): unknown {
  if (!record(original) || !Array.isArray(original.nativeGroups) || !record(baseline)
    || !Array.isArray(baseline.nativeGroups)) return baseline;
  let current = baseline as Record<string, unknown> & { nativeGroups: unknown[] };
  original.nativeGroups.forEach((entry, index) => {
    if (!offered(entry)) return;
    // A shortened or redacted fact list is unusable; keep the explicit refusal.
    if (JSON.stringify(JSON.parse(evidenceJson(entry).text)) !== JSON.stringify(entry)) return;
    const candidate = { ...current, nativeGroups: current.nativeGroups.map((row, i) => i === index ? entry : row) };
    if (fits(candidate)) current = candidate;
  });
  return current;
}
