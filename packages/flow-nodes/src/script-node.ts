/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `script.run` — the one node that executes user code, in the QuickJS
 * sandbox (`bim.sandbox`), with the sandbox's own `bim` API. This is the
 * Dynamo "Python Script" analog: it sees `inputs.a/b/c` and returns the
 * value of its last expression as `result`.
 *
 * The sandbox `bim` is *not* the SDK `bim` the built-in nodes use (it has
 * no `bcf`, `ids`, `spatial`); that difference is documented, not papered
 * over. Sandbox permissions are derived from the graph's grants: mutation
 * is only enabled when a `model.mutate` grant exists.
 */

import { createSandbox, type Sandbox } from '@ifc-lite/sandbox';
import type { BimContext } from '@ifc-lite/sdk';
import { ANY_ITEM, requireCapability, type FlowNodeDef } from './host.js';

/**
 * One sandbox per (BimContext, permission set), kept for the lifetime of
 * the context: QuickJS module init is the expensive part, and a graph with
 * several Script nodes (or a re-run) must not pay it per lane. Created here
 * rather than through `bim.sandbox` because that path dynamically imports
 * `@ifc-lite/sandbox` relative to the SDK package, which a pnpm-isolated
 * install cannot resolve headlessly.
 */
const sandboxes = new WeakMap<BimContext, Map<string, Promise<Sandbox>>>();

function sandboxFor(bim: BimContext, permissions: Record<string, boolean>, timeoutMs: number): Promise<Sandbox> {
  const key = JSON.stringify({ permissions, timeoutMs });
  let perContext = sandboxes.get(bim);
  if (!perContext) {
    perContext = new Map();
    sandboxes.set(bim, perContext);
  }
  let pending = perContext.get(key);
  if (!pending) {
    // A rejected creation (a wasm load failure, a transient resource limit)
    // must not be cached: every later lane would await the same rejection for
    // the lifetime of the context, turning one hiccup into a dead node.
    pending = createSandbox(bim, { permissions, limits: { timeoutMs } }).catch((err) => {
      if (perContext!.get(key) === pending) perContext!.delete(key);
      throw err;
    });
    perContext.set(key, pending);
  }
  return pending;
}

export const scriptNode: FlowNodeDef = {
  type: 'script.run',
  title: 'Script',
  category: 'script',
  doc: 'Runs JavaScript (not TypeScript) in the sandbox with `inputs.a`, `inputs.b`, `inputs.c` and the sandbox `bim` API; the last expression is `result`.',
  inputs: [
    { name: 'a', type: ANY_ITEM, optional: true, nullable: true },
    { name: 'b', type: ANY_ITEM, optional: true, nullable: true },
    { name: 'c', type: ANY_ITEM, optional: true, nullable: true },
  ],
  outputs: [{ name: 'result', type: ANY_ITEM }],
  params: [
    { name: 'code', kind: 'string', default: 'inputs.a' },
    { name: 'timeoutMs', kind: 'number', default: 30_000 },
  ],
  capabilities: ['model.read'],
  reads: 'model',
  requires: { backend: ['sandbox'] },
  run: async (ctx, inputs, params) => {
    // The node declares `model.read`; without this check a graph granted
    // nothing still got a sandbox with query+model on, so user code could
    // read the model through a capability the graph never had.
    requireCapability(ctx, 'model.read');
    const grants = ctx.host.grants;
    const has = (scope: string, action: string) => !grants || grants.some((g) => g.scope === scope && g.action === action);
    const permissions = {
      query: true,
      model: true,
      viewer: has('viewer', 'colorize') || has('viewer', 'isolate') || has('viewer', 'fly') || has('viewer', 'section'),
      mutate: has('model', 'mutate'),
      store: has('model', 'create'),
      export: has('export', 'create'),
      lens: true,
      files: true,
    };
    const injected = JSON.stringify({ a: inputs.a ?? null, b: inputs.b ?? null, c: inputs.c ?? null });
    const code = `const inputs = ${injected};\n${String(params.code ?? '')}`;
    const sandbox = await sandboxFor(ctx.host.bim, permissions, Number(params.timeoutMs) || 30_000);
    // Plain JavaScript by contract: skipping the TypeScript strip avoids
    // initialising esbuild-wasm, which only works in the browser.
    const result = await sandbox.eval(code, { typescript: false });
    for (const entry of result.logs) {
      const level = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info';
      ctx.log(level, entry.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    }
    return { result: result.value ?? null };
  },
};
