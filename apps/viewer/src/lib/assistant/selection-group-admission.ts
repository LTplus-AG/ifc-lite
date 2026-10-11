/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { evidenceJson } from './projection';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const offered = (entry: unknown): boolean =>
  record(entry) && entry.status === 'available' && Array.isArray(entry.expectedJsonParts);
const refused = (entry: unknown): unknown => offered(entry)
  ? { ...(entry as Record<string, unknown>), status: 'unavailable-transport-budget', expectedJsonParts: null } : entry;

/** #7329: Group facts, and even their status entries, are optional. Reserve
 * ordinary selected rows first by leaving `nativeGroups` out of the baseline. */
export function selectionGroupBaseline(summary: unknown): unknown {
  if (!record(summary) || !Array.isArray(summary.nativeGroups)) return summary;
  const { nativeGroups: _deferred, ...rest } = summary;
  return rest;
}

/** Admit the status entries, then each unchanged whole Group pin, only while the
 * complete envelope still fits. A refused pin stays explicitly unavailable; when
 * not even the status entries fit, `nativeGroups` stays absent and `omitted`
 * tells the caller to mark the projection truncated. */
export function admitSelectionGroups(original: unknown, baseline: unknown,
  fits: (summary: unknown) => boolean): { summary: unknown; omitted: boolean } {
  if (!record(original) || !Array.isArray(original.nativeGroups) || !record(baseline)) return { summary: baseline, omitted: false };
  // Keep the adapter's key order so the sent summary reads as captured.
  const place = (nativeGroups: unknown[]) => Object.fromEntries(Object.keys(original)
    .filter(key => key === 'nativeGroups' || key in baseline).map(key => [key, key === 'nativeGroups' ? nativeGroups : baseline[key]]));
  let groups = original.nativeGroups.map(refused);
  if (!fits(place(groups))) return { summary: baseline, omitted: true };
  original.nativeGroups.forEach((entry, index) => {
    if (!offered(entry)) return;
    // A shortened or redacted fact list is unusable; keep the explicit refusal.
    if (JSON.stringify(JSON.parse(evidenceJson(entry).text)) !== JSON.stringify(entry)) return;
    const candidate = groups.map((row, i) => i === index ? entry : row);
    if (fits(place(candidate))) groups = candidate;
  });
  return { summary: place(groups), omitted: false };
}
