// SPDX-License-Identifier: MPL-2.0
// Resolve root-absolute SDK imports to the protocol peer (tests only).
let peer, client, sequence = 0;
export function initialize(data) { peer = data.peer; client = data.client; }
export function resolve(specifier, context, next) {
  // A fresh module evaluation lets a test hold any driver's startup.
  if (specifier === '/smlib/client.mjs') return { url: `${client}?load=${sequence++}`, shortCircuit: true };
  if (specifier.startsWith('/smlib/')) return { url: peer, shortCircuit: true };
  return next(specifier, context);
}
