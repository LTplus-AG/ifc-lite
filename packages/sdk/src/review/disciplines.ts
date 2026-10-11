/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DISCIPLINES, matchesSelector } from '@ifc-lite/clash';

/** Native taxonomy hints, retaining overlapping and unknown discipline candidates. */
export function typeDisciplines(ifcType: string | undefined): string[] {
  return ifcType ? Object.values(DISCIPLINES).filter(discipline => matchesSelector(ifcType, discipline.selector))
    .map(discipline => discipline.code) : [];
}
