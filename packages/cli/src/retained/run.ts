// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import type { IfcAPI, RetainedProductOutcome } from '../../../wasm/pkg-retained/ifc-lite.js';
import type { RetainedEngine } from './engine.js';
import { registerSmlibHooks } from './smlib-hooks.js';

/** The declarations belong only to pkg-retained; the default engine has no new API. */
export async function runRetained(engine: RetainedEngine, bytes: Uint8Array, ids?: Uint32Array): Promise<RetainedProductOutcome[]> {
  await registerSmlibHooks(engine);
  const module: typeof import('../../../wasm/pkg-retained/ifc-lite.js') =
    await import(new URL('pkg-retained/ifc-lite.js', engine.url).href);
  await module.default({ module_or_path: await readFile(new URL('pkg-retained/ifc-lite_bg.wasm', engine.url)) });
  const api = new module.IfcAPI();
  try {
    return await collectRetained(api, bytes, ids);
  } finally {
    api.free();
  }
}

export async function collectRetained(api: Pick<IfcAPI, 'retainedModel'>, bytes: Uint8Array, ids?: Uint32Array): Promise<RetainedProductOutcome[]> {
  const run = await api.retainedModel(bytes, ids);
  try {
    const products: RetainedProductOutcome[] = [];
    for (let product = run.next(); product !== undefined; product = run.next()) products.push(product);
    return products.sort((a, b) => a.expressId - b.expressId);
  } finally {
    run.free();
  }
}
