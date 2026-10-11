/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Lens } from '@ifc-lite/lens';
import { migrateSavedLens } from './migrate-saved-lens.js';

/** Restore an opaque flavor snapshot through the same native Lens codec (#7186). */
export function decodeFlavorLenses(definitions: readonly unknown[]): Lens[] {
  return definitions.flatMap(value => {
    const decoded = migrateSavedLens(value);
    if (value !== null && typeof value === 'object' && 'format' in value
      && value.format === 'ifc-lite-captured-lens' && (!decoded || !decoded.id)) {
      throw new Error('The captured Lens population in this flavor cannot be read.');
    }
    return decoded?.id ? [{ ...decoded, id: decoded.id }] : [];
  });
}
