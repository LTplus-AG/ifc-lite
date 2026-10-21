// SPDX-License-Identifier: MPL-2.0
// Resolve hook: the driver's root-absolute /smlib/ imports reach the protocol
// peer below instead of a deployed SDK bundle (tests only).
let peer;
export function initialize(data) { peer = data.peer; }
export function resolve(specifier, context, next) {
  if (specifier.startsWith('/smlib/')) return { url: peer, shortCircuit: true };
  return next(specifier, context);
}
