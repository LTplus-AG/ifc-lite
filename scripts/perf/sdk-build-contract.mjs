/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Actual Turbo output is producing evidence, never a source-text assertion.
export function buildOutcomes(text) {
  const tasks = /Tasks:\s+(\d+) successful,\s+(\d+) total/.exec(text);
  const cache = /Cached:\s+(\d+) cached,\s+(\d+) total/.exec(text);
  const names = ['geometry', 'data', 'encoding', 'wasm-lifecycle', 'wasm'];
  if (!tasks || !cache || Number(tasks[1]) < names.length || tasks[1] !== tasks[2]
    || Number(cache[1]) !== 0 || cache[2] !== tasks[2]
    || !names.every(name => new RegExp(`^@ifc-lite/${name}:build: cache (?:bypass, force executing|miss, executing) [a-f0-9]+$`, 'm').test(text))
    || !/^@ifc-lite\/wasm:build: .*Build complete!$/m.test(text)) {
    throw new Error('fresh forced SDK/WASM task outcomes missing');
  }
  return { successful: Number(tasks[1]), total: Number(tasks[2]), cached: Number(cache[1]), names };
}
