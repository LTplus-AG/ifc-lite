/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StructuralExtraction, StructuralMemberInfo } from '@ifc-lite/parser';
/** Native StructuralCard selection contract, shared with evidence (#7195). */
export function selectedStructuralMember(data: StructuralExtraction | null, expressId: number | null,
  globalId: string | null | undefined): StructuralMemberInfo | null {
  if (!data) return null;
  const byGlobalId = globalId ? data.members.find(member => member.globalId === globalId) : undefined;
  return byGlobalId ?? (expressId !== null && expressId > 0 ? data.members.find(member => member.expressId === expressId) : undefined) ?? null;
}
