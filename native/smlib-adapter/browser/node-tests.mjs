// SPDX-License-Identifier: MPL-2.0
import { pathToFileURL } from 'node:url';
import { runSweepContract } from './sweep-contract.mjs';
import { dispatchOwned } from './module.mjs';
import { assert, request, runContract } from './contract.mjs';
const { default: createModule } = await import(pathToFileURL(process.argv[2]).href);
const modules = await Promise.all([createModule(), createModule()]);
const results = [], sweeps = [];
for (const module of modules) {
  const transport = {
    incarnation: Object.freeze({}),
    retire(token) { if (this.incarnation === token) this.incarnation = undefined; },
    dispose() { this.incarnation = undefined; },
    async batch(frames, token) {
      if (!this.incarnation || token !== this.incarnation) throw new Error('module retired');
      return frames.map((frame) => dispatchOwned(module, frame));
    },
  };
  sweeps.push(await runSweepContract(transport, transport.incarnation));
  results.push(await runContract(async (frames) => frames.map((frame) => dispatchOwned(module, frame))));
  for (const invalid of [new ArrayBuffer(11), request(99), request(0, new Uint8Array([1]))]) {
    let rejected = false;
    try { dispatchOwned(module, invalid); } catch { rejected = true; }
    assert(rejected, 'malformed frame rejected');
  }
}
assert(JSON.stringify(sweeps[0]) === JSON.stringify(sweeps[1]), 'independent sweep instance results');
assert(JSON.stringify(results[0]) === JSON.stringify(results[1]), 'independent WASM instance results');
console.log(JSON.stringify({ passed: true, instances: 2, results, sweeps }));
