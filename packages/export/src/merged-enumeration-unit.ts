/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { getCompleteEntityIndex } from './entity-iteration.js';
import { readStepSlots } from './step-argument-parser.js';
import { holdsValue, withoutComments } from './step-comment-skip.js';

/** Resolve EnumerationReference in source id space, once per referenced domain. */
export function enumerationUnitLookup(model: IfcDataStore): (type: string, selection: string) => boolean {
  const index = getCompleteEntityIndex(model);
  const cache = new Map<number, boolean>();
  return (type, selection) => {
    if (type.toUpperCase() !== 'IFCPROPERTYENUMERATEDVALUE') return false;
    const token = withoutComments(readStepSlots(selection)?.slots[3] ?? '');
    if (!/^#\d+$/.test(token)) return false;
    const id = Number(token.slice(1));
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const ref = index.get(id);
    const domain = ref?.type.toUpperCase() === 'IFCPROPERTYENUMERATION'
      ? model.source?.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength) : undefined;
    const explicit = domain !== undefined && holdsValue(readStepSlots(domain)?.slots[2] ?? '');
    cache.set(id, explicit);
    return explicit;
  };
}
