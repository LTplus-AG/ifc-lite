/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DISCIPLINES, matchesSelector, type Clash } from '@ifc-lite/clash';

/** Native selector candidates remain hints, never verified responsibilities. */
export function clashDisciplineCandidates(clash: Pick<Clash, 'a' | 'b'>) {
  function candidates(tag: string): string[] {
    return Object.values(DISCIPLINES).filter(discipline => matchesSelector(tag, discipline.selector)).map(discipline => discipline.code);
  }
  return { a: candidates(clash.a.tag), b: candidates(clash.b.tag) };
}

/** Exact occurrence identity, distinct from model-independent human review keys. */
export function clashOccurrenceKey(clash: Pick<Clash, 'rule' | 'a' | 'b'>): string {
  const elements = [clash.a, clash.b].map(element => [element.model, element.key] as const)
    .sort(([modelA, keyA], [modelB, keyB]) => modelA < modelB ? -1 : modelA > modelB ? 1 : keyA < keyB ? -1 : keyA > keyB ? 1 : 0);
  return JSON.stringify([clash.rule, ...elements]);
}
