/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StructuralExtraction, StructuralMemberInfo } from '@ifc-lite/parser';
/** Native StructuralCard selection contract, shared with evidence (#7195). */
export function selectedStructuralMember(data: StructuralExtraction | null, expressId: number | null,
  globalId: string | null | undefined): StructuralMemberInfo | null {
  if (!data) return null;
  if (expressId !== null && expressId > 0) return data.members.find(member => member.expressId === expressId) ?? null;
  if (!globalId) return null;
  const candidates = data.members.filter(member => member.globalId === globalId);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Native cross-links contain GUIDs only: duplicate or missing targets cannot be resolved honestly. */
export function structuralRelatedRows<T extends { globalId: string }>(rows: readonly T[], ids: readonly string[]) {
  const byId = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (byId.has(row.globalId)) duplicates.add(row.globalId);
    else byId.set(row.globalId, row);
  }
  const resolved: T[] = [];
  let unavailable = false;
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || duplicates.has(id)) unavailable = true;
    else resolved.push(row);
  }
  return { rows: resolved, unavailable };
}
