// SPDX-License-Identifier: MPL-2.0
// CTest: the actual browser binary under Node. Two independent module
// instances run the shared SDK sweep witness through the owned dispatch.
import { pathToFileURL } from 'node:url';
import { runSweepContract } from './sweep-contract.mjs';
import { dispatchOwned } from './module.mjs';
import { assert, request } from './contract.mjs';
const { default: createModule } = await import(pathToFileURL(process.argv[2]).href);
const modules = await Promise.all([createModule(), createModule()]);
const sweeps = [];
for (const module of modules) {
  const transport = {
    incarnation: Object.freeze({}),
    retire(token) { if (this.incarnation === token) this.incarnation = undefined; },
    async batch(frames, token) {
      if (!this.incarnation || token !== this.incarnation) throw new Error('module retired');
      return frames.map((frame) => dispatchOwned(module, frame));
    },
  };
  sweeps.push(await runSweepContract(transport, transport.incarnation));
  for (const invalid of [new ArrayBuffer(11), new ArrayBuffer(4097), request(99), request(0, new Uint8Array([1]))]) {
    let rejected = false;
    try { dispatchOwned(module, invalid); } catch { rejected = true; }
    assert(rejected, 'malformed frame rejected');
  }
}
assert(JSON.stringify(sweeps[0]) === JSON.stringify(sweeps[1]), 'independent module instances agree');
console.log(JSON.stringify({ passed: true, instances: 2, sweeps }));
