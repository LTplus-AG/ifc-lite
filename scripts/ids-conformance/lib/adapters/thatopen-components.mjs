/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dashboard adapter for the IDS module of the open-source npm package
 * `@thatopen/components` (MIT), run headless in Node.
 *
 * Nothing here is a dependency of this repository. Install the engine into a
 * directory of your choice and pass it with `--thatopen-root <dir>`:
 *
 *   npm install --prefix <dir> --ignore-scripts \
 *     @thatopen/components@3.4.9 @thatopen/fragments@3.4.8 \
 *     web-ifc@0.0.78 three@0.182.0 camera-controls web-worker
 *
 * The engine itself runs in `thatopen-process.mjs` (a child process), which
 * documents the headless shims it needs.
 */

import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * IDS 1.0 specification cardinality from the `<applicability>` attributes
 * (`minOccurs` defaults to 1, `maxOccurs="0"` is prohibited). Read from the
 * IDS text with a pattern so this column does not depend on ifc-lite's parser.
 * @param {string} idsXml
 */
export function applicabilityOccurs(idsXml) {
  const tag = /<(?:\w+:)?applicability\b([^>]*)>/.exec(idsXml)?.[1] ?? '';
  const min = /\bminOccurs\s*=\s*"(\d+)"/.exec(tag)?.[1];
  const max = /\bmaxOccurs\s*=\s*"(\w+)"/.exec(tag)?.[1];
  return { minOccurs: min === undefined ? 1 : Number(min), maxOccurs: max === undefined || max === 'unbounded' ? Infinity : Number(max) };
}

/**
 * Spec verdict from per-element results plus IDS 1.0 cardinality.
 * @param {number} applicable
 * @param {number} failed
 * @param {{ minOccurs: number, maxOccurs: number }} occurs
 * @returns {'pass' | 'fail'}
 */
export function specVerdict(applicable, failed, occurs) {
  if (occurs.maxOccurs === 0) return applicable > 0 ? 'fail' : 'pass';
  if (applicable < occurs.minOccurs || applicable > occurs.maxOccurs) return 'fail';
  return failed > 0 ? 'fail' : 'pass';
}

/**
 * The engine runs in a child process (`thatopen-process.mjs`): its headless
 * shims (a global `Worker`, a `window`) must not leak into other engines'
 * columns, and ifc-lite's parser does look for a global `Worker`.
 * @param {string} root  install directory holding `node_modules/@thatopen/components`
 * @returns {Promise<import('../matrix.mjs').EngineAdapter>}
 */
export async function createThatOpenAdapter(root) {
  const child = fork(fileURLToPath(new URL('./thatopen-process.mjs', import.meta.url)), [root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let serial = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  child.on('message', (/** @type {any} */ msg) => {
    const waiter = pending.get(msg.seq);
    if (!waiter) return;
    pending.delete(msg.seq);
    if (msg.error) waiter.reject(new Error(msg.error));
    else waiter.resolve(msg.result);
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`engine process exited with code ${code}`));
    pending.clear();
  });
  /** @param {object} request */
  const call = (request) => new Promise((resolve, reject) => {
    const seq = serial++;
    pending.set(seq, { resolve, reject });
    child.send({ seq, ...request });
  });
  const info = /** @type {import('../matrix.mjs').EngineInfo} */ (await call({ kind: 'info' }));
  return {
    info,
    async validate({ idsPath, ifcPath }) {
      const { applicable, failed } = /** @type {{ applicable: number, failed: number }} */ (await call({ kind: 'validate', idsPath, ifcPath }));
      const occurs = applicabilityOccurs(readFileSync(idsPath, 'utf8'));
      const max = occurs.maxOccurs === Infinity ? 'unbounded' : occurs.maxOccurs;
      return {
        verdict: specVerdict(applicable, failed, occurs),
        detail: `${applicable} applicable, ${failed} failed (minOccurs ${occurs.minOccurs}, maxOccurs ${max})`,
      };
    },
    async close() {
      child.kill();
    },
  };
}
