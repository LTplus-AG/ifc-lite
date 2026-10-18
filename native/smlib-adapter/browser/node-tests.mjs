// SPDX-License-Identifier: MPL-2.0
import { pathToFileURL } from 'node:url';
import { dispatchOwned } from './module.mjs';
import { assert, request, runContract } from './contract.mjs';
const { default: createModule } = await import(pathToFileURL(process.argv[2]).href);
const modules = await Promise.all([createModule(), createModule()]);
const results = [];
for (const module of modules) {
  results.push(await runContract(async (frames) => frames.map((frame) => dispatchOwned(module, frame))));
  for (const invalid of [new ArrayBuffer(11), request(99), request(0, new Uint8Array([1]))]) {
    let rejected = false;
    try { dispatchOwned(module, invalid); } catch { rejected = true; }
    assert(rejected, 'malformed frame rejected');
  }
}
assert(JSON.stringify(results[0]) === JSON.stringify(results[1]), 'independent WASM instance results');
console.log(JSON.stringify({ passed: true, instances: 2, results }));
