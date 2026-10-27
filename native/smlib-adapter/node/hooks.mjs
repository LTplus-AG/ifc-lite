// SPDX-License-Identifier: MPL-2.0
// node:module register(new URL('smlib/node/hooks.mjs', engineUrl),
//   { data: { smlib: new URL('smlib/', engineUrl).href } });
// Register before importing pkg-retained; requires Node >=20.6.
let root;
export function initialize({ smlib }) {
  root = new URL(smlib);
  if (root.protocol !== 'file:' || !root.pathname.endsWith('/')) {
    throw new Error('smlib hook requires a file directory URL');
  }
}
export function resolve(specifier, context, next) {
  if (specifier === '/smlib/client.mjs') {
    return { url: new URL('node/client.mjs', root).href, shortCircuit: true };
  }
  if (['/smlib/sweep.mjs', '/smlib/sweep-contract.mjs', '/smlib/contract.mjs'].includes(specifier)) {
    return { url: new URL(specifier.slice('/smlib/'.length), root).href, shortCircuit: true };
  }
  return next(specifier, context);
}
