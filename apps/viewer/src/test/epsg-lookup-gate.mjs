/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Delay only this dialog's real local-index calls; other data consumers pass through.
const MARKER = 'epsg-lookup-gate:';
export async function resolve(specifier, context, nextResolve) {
  const real = await nextResolve(specifier, context);
  if (!context.parentURL?.startsWith(MARKER)
    && /\/EpsgLookupDialog\.tsx(?:\?|$)/.test(context.parentURL ?? '')
    && (specifier === '@ifc-lite/data' || /\/packages\/data\/(?:src\/index\.ts|dist\/index\.js)(?:\?|$)/.test(real.url))) {
    return { url: MARKER + real.url, shortCircuit: true, format: 'module' };
  }
  return real;
}
export async function load(url, context, nextLoad) {
  if (!url.startsWith(MARKER)) return nextLoad(url, context);
  const real = JSON.stringify(url.slice(MARKER.length));
  return { format: 'module', shortCircuit: true, source: `
export * from ${real};
import { lookupEpsgByCode as lookup, searchEpsgIndex as search } from ${real};
export function lookupEpsgByCode(...args) {
  return globalThis.__epsgLookupGate?.(String(args[0]), () => lookup(...args)) ?? lookup(...args);
}
export function searchEpsgIndex(...args) {
  return globalThis.__epsgLookupGate?.(String(args[0]), () => search(...args)) ?? search(...args);
}
` };
}
