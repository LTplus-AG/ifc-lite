/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ClassificationInfo } from '@ifc-lite/parser';

const text = (value: string) => value.length > 240 ? `${value.slice(0, 240)}…` : value;

/** Project native classification values without inventing missing identity or system data (#7139). */
export function classificationEvidence(info: ClassificationInfo, schema: string | undefined, pathLimit: number) {
  return {
    verification: info.unresolved ? 'unverified' as const : 'resolved' as const,
    Name: info.name === undefined ? null : text(info.name),
    system: info.system === undefined ? null : { Name: text(info.system) },
    ...(info.identification === undefined ? {} : schema?.toUpperCase() === 'IFC2X3'
      ? { ItemReference: text(info.identification) } : { Identification: text(info.identification) }),
    ...(info.location === undefined ? {} : { Location: text(info.location) }),
    ...(info.description === undefined ? {} : { Description: text(info.description) }),
    pathCount: info.unresolved ? null : info.path?.length ?? null,
    path: info.path?.slice(0, pathLimit).map(text) ?? [],
  };
}
