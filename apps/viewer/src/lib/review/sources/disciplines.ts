/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clashDisciplineCandidates } from '../../assistant/clash-taxonomy';

/** The native clash taxonomy's selector candidates for one IFC type: hints, never a responsibility mapping. */
export function typeDisciplines(ifcType: string | undefined): string[] {
  if (!ifcType) return [];
  const side = { key: '', ref: 0, model: '', tag: ifcType };
  return clashDisciplineCandidates({ a: side, b: { ...side, tag: '' } }).a;
}
