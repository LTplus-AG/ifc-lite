/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Value } from '../runtime/values.js';
import type { ValidationFinding } from './findings.js';

/** Evaluate a compiled rule; a runtime failure becomes an `evaluation_error` finding instead of a silent pass. */
export function guard(
  out: ValidationFinding[],
  rule: string,
  instance: number | undefined,
  entity: string | undefined,
  run: () => Value,
): { ok: true; value: Value } | { ok: false } {
  try {
    return { ok: true, value: run() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    out.push({ category: 'evaluation_error', rule, ...(instance !== undefined ? { instance } : {}), ...(entity ? { entity } : {}), message });
    return { ok: false };
  }
}
