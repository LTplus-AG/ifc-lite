// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import type { IfcAPI, RetainedProductOutcome } from '../../../wasm/pkg-retained/ifc-lite.js';
import type { RetainedEngine } from './engine.js';
import { registerSmlibHooks } from './smlib-hooks.js';

/** The declarations belong only to pkg-retained; the default engine has no new API. */
export async function runRetained(engine: RetainedEngine, bytes: Uint8Array, ids?: Uint32Array): Promise<{ outcomes: RetainedProductOutcome[]; instanceMinOccurrences: number }> {
  await registerSmlibHooks(engine);
  const module: typeof import('../../../wasm/pkg-retained/ifc-lite.js') =
    await import(new URL('pkg-retained/ifc-lite.js', engine.url).href);
  // An engine staged before the instancing threshold export has a consistent inventory;
  // name the remedy instead of failing on an undefined function.
  if (typeof module.instanceMinOccurrences !== 'function') {
    throw new Error('Retained engine predates the instancing threshold export; ' +
      're-stage the engine with the current scripts/stage-cli-retained-engine.mjs');
  }
  await module.default({ module_or_path: await readFile(new URL('pkg-retained/ifc-lite_bg.wasm', engine.url)) });
  const api = new module.IfcAPI();
  try {
    return { outcomes: await collectRetained(api, bytes, ids), instanceMinOccurrences: module.instanceMinOccurrences() };
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
