/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { lookupEpsgByCode, searchEpsgIndex } from '@ifc-lite/data';
import { COMMON_CRS, toDialogResult, type EpsgResult } from './epsg-lookup-results';
/** Shared offline EPSG index lookup, including the panel's starter-code preference and de-duplication. */
export async function searchViewerEpsg(query: string, signal?: AbortSignal, onLocal?: (results: EpsgResult[]) => void): Promise<EpsgResult[]> {
  signal?.throwIfAborted(); const trimmed = query.trim(); if (!trimmed) return [];
  const code = /^\d+$/.test(trimmed), lower = trimmed.toLowerCase();
  const local = COMMON_CRS.filter(crs => code ? crs.code.startsWith(trimmed) : `${crs.code} ${crs.name} ${crs.area} ${crs.datum ?? ''} ${crs.projection ?? ''}`.toLowerCase().includes(lower)).slice(0, 10);
  onLocal?.(local);
  const resolved = code ? await lookupEpsgByCode(trimmed, { prefix: true, limit: 25 }) : await searchEpsgIndex(trimmed, { limit: 25 }); signal?.throwIfAborted();
  const authoritative = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
  const seen = new Set<string>(), results: EpsgResult[] = [];
  for (const entry of [...local, ...authoritative.map(toDialogResult)]) {
    if (seen.has(entry.code)) continue; seen.add(entry.code); results.push(entry); if (results.length >= 25) break;
  }
  return results;
}
