/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DISCIPLINES, matchesSelector, type Clash } from '@ifc-lite/clash';

/** Native selector candidates are hints, never a verified responsibility mapping. */
export function clashDisciplineCandidates(clash: Pick<Clash, 'a' | 'b'>) {
  function candidates(tag: string): string[] {
    return Object.values(DISCIPLINES)
      .filter(discipline => matchesSelector(tag, discipline.selector))
      .map(discipline => discipline.code);
  }
  return { a: candidates(clash.a.tag), b: candidates(clash.b.tag) };
}

export const CLASH_TAXONOMY_LIMITATIONS =
  'Default taxonomy: native status (detection type) and severity plus discipline pairs. ' +
  'disciplineCandidates are native IFC-type selector hints for each side, not verified project mappings. ' +
  'Multiple candidates are ambiguous; an empty list is unknown. Preserve all alternatives and side/model identities. ' +
  'Detection status is not human review status. Never change native severity or infer resolved/accepted from grouping. ' +
  'Omitted findings remain unclassified. BCF assignees stay empty until a verified project mapping is chosen.';
