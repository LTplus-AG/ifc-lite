/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { OccurrenceQuantityReadError } from '@ifc-lite/parser';
import type { QuantitySet } from './encodingUtils';

/** Match the inherited quantity coverage contract: unavailable is not absence. */
export function readOccurrenceQuantityResult(read: () => QuantitySet[]): {
  status: 'available' | 'unavailable'; reason: string | null; quantities: QuantitySet[];
} {
  try {
    return { status: 'available', reason: null, quantities: read() };
  } catch (error) {
    if (!(error instanceof OccurrenceQuantityReadError)) throw error;
    return { status: 'unavailable', reason: error.message, quantities: [] };
  }
}
