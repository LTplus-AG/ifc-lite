/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export function resolve(specifier, context, nextResolve) {
  if (specifier === '@playwright/test') {
    return { url: new URL('./browser.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (/browser-cold-ab\.mts/.test(context.parentURL ?? '') && /browser-cold-sample\.(?:js|ts)$/.test(specifier)) {
    return { url: new URL('./sample-observer.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
