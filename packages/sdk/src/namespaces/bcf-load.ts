/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared `@ifc-lite/bcf` loader for the `bim.bcf` namespace.
 *
 * Split out of `bcf.ts` so `bcf-guid-color.ts` (the GUID/color utility
 * methods, moved out to keep `bcf.ts` under the module-size ratchet) does
 * not need its own copy of the dynamic import.
 */

export async function loadBCF(): Promise<Record<string, unknown>> {
  const name = '@ifc-lite/bcf';
  return import(/* webpackIgnore: true */ name) as Promise<Record<string, unknown>>;
}

export type AnyFn = (...args: unknown[]) => unknown;
