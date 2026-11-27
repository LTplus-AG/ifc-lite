/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StepInteger, StepReal, type Value } from './values.js';

/** Compare stored aggregate members with their SELECT tags and reference identities intact. */
export function uniqueAggregate(items: Value[]): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    if (item === undefined) continue;
    const key = JSON.stringify(item, (_field, v: unknown) => {
      if (v instanceof StepInteger || v instanceof StepReal) return v.value;
      if (typeof v === 'symbol') return { logical: String(v) };
      return v;
    });
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
