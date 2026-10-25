// SPDX-License-Identifier: MPL-2.0
// Runs outside the workspace, against the installed archive's real default WASM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let fetches = 0, workers = 0;
globalThis.fetch = () => { fetches++; throw new Error('Unexpected startup fetch'); };
globalThis.Worker = class { constructor() { workers++; throw new Error('Unexpected startup Worker'); } };
const engine = await import('@ifc-lite/wasm');
const loader = await import('@ifc-lite/wasm/retained');
assert.equal(Object.hasOwn(engine, 'inspectDevelopmentSource'), false);
assert.equal(Object.hasOwn(loader, 'inspectDevelopmentSource'), false);
await assert.rejects(import('@ifc-lite/wasm/development-inspection'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const module = new WebAssembly.Module(readFileSync(new URL(import.meta.resolve('@ifc-lite/wasm/ifc-lite_bg.wasm'))));
assert.equal(WebAssembly.Module.imports(module).some(entry => /inspectionMonotonicNow/iu.test(entry.name)), false);
engine.initSync({ module });
const api = new engine.IfcAPI();
try { assert.equal('inspectDevelopmentSource' in api, false); }
finally { api.free(); }
assert.equal(fetches, 0); assert.equal(workers, 0);
console.log(JSON.stringify({ actualDefaultWasm: true, developmentExcluded: true, fetches, workers }));
