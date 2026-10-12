/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** New APIs must fail a behavioral assertion when absent on the base revision,
 * not prevent the test runner from collecting the regression cases. Only the
 * requested module's absence is an unavailable feature; broken dependencies,
 * syntax and initialization errors remain errors. This is test harness only. */
export async function loadFeature<T>(
  specifier: string,
  load: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    if (
      error instanceof Error &&
      [specifier, specifier.replace(/^\.\.\//, "/")].some((request) =>
        error.message.startsWith(`Cannot find module '${request}' imported from `),
      )
    )
      return undefined;
    throw error;
  }
}
