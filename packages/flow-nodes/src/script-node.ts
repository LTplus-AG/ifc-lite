/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `script.run` and `script.list` — the two nodes that execute user code, in
 * the QuickJS sandbox (`bim.sandbox`), with the sandbox's own `bim` API.
 * This is the Dynamo "Python Script" analog: the code sees `inputs.a/b/c`
 * and the value of its last expression is the output.
 *
 * The two differ only in the access their ports declare, which is what
 * decides whether the scheduler lifts them: `script.run` takes items, so a
 * list arriving on `a` runs the code once per element; `script.list` takes
 * whole lists and returns one, which is what ranking, sorting, and any
 * whole-set computation needs (and what a per-item node cannot express).
 *
 * The sandbox `bim` is *not* the SDK `bim` the built-in nodes use (it has
 * no `bcf`, `ids`, `spatial`); that difference is documented, not papered
 * over. Sandbox permissions are derived from the graph's grants: mutation
 * is only enabled when a `model.mutate` grant exists.
 */

import { createSandbox, type Sandbox } from '@ifc-lite/sandbox';
import type { BimContext } from '@ifc-lite/sdk';
import { ANY_ITEM, ANY_LIST, requireCapability, type Ctx, type FlowNodeDef } from './host.js';

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

/** Evaluate `params.code` with `inputs` in scope and return its last expression. */
async function evaluate(ctx: Ctx, inputs: Readonly<Record<string, unknown>>, params: Readonly<Record<string, unknown>>): Promise<unknown> {
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
  // Every lane shares one sandbox, and QuickJS evaluates a program in the
  // GLOBAL lexical scope — so a second lane re-running `const inputs = …`,
  // or any `const` the user wrote, died with "redeclaration of 'x'". Every
  // lane but the first then logged an error and yielded null, which a
  // downstream filter reads as a legitimate answer. Running the source
  // through a direct `eval` inside a function gives each lane its own
  // variable environment while keeping the two things the node promises:
  // `inputs` in scope, and the last expression as the value (`eval` returns
  // its program's completion value, which a function body would not).
  const code = `(function (inputs) { return eval(${JSON.stringify(String(params.code ?? ''))}); })(${injected})`;
  const sandbox = await sandboxFor(ctx.host.bim, permissions, Number(params.timeoutMs) || 30_000);
  // Plain JavaScript by contract: skipping the TypeScript strip avoids
  // initialising esbuild-wasm, which only works in the browser. It is also
  // what keeps the wrapper above honest — the source reaches `eval`
  // verbatim, not as something a transpiler rewrote.
  const result = await sandbox.eval(code, { typescript: false });
  for (const entry of result.logs) {
    const level = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info';
    ctx.log(level, entry.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
  return result.value ?? null;
}

/** The shared editable surface, so the two nodes cannot drift apart. */
const SCRIPT_PARAMS = [
  { name: 'code', kind: 'code', language: 'javascript', default: 'inputs.a', doc: 'JavaScript (not TypeScript). The value of the last expression is the output.' },
  { name: 'timeoutMs', kind: 'number', default: 30_000, doc: 'Hard limit per evaluation; the sandbox is interrupted when it is exceeded.' },
] as const;

export const scriptNode: FlowNodeDef = {
  type: 'script.run',
  title: 'Script',
  category: 'script',
  doc: 'Runs JavaScript (not TypeScript) in the sandbox with `inputs.a`, `inputs.b`, `inputs.c` and the sandbox `bim` API; the last expression is `result`. A list on an input runs the code once per element. An entity arrives as `{ globalId, modelId, expressId }`, which is also a `bim.*` ref.',
  inputs: [
    { name: 'a', type: ANY_ITEM, optional: true, nullable: true },
    { name: 'b', type: ANY_ITEM, optional: true, nullable: true },
    { name: 'c', type: ANY_ITEM, optional: true, nullable: true },
  ],
  outputs: [{ name: 'result', type: ANY_ITEM }],
  params: [...SCRIPT_PARAMS],
  capabilities: ['model.read'],
  reads: 'model',
  requires: { backend: ['sandbox'] },
  run: async (ctx, inputs, params) => ({ result: await evaluate(ctx, inputs, params) }),
};

export const scriptListNode: FlowNodeDef = {
  type: 'script.list',
  title: 'Script (list)',
  category: 'script',
  doc: 'Like Script, but `inputs.a/b/c` are whole lists and the last expression must be an array — for sorting, ranking, and anything that needs the whole set at once.',
  inputs: [
    { name: 'a', type: ANY_LIST, optional: true },
    { name: 'b', type: ANY_LIST, optional: true },
    { name: 'c', type: ANY_LIST, optional: true },
  ],
  outputs: [{ name: 'items', type: ANY_LIST }],
  params: [...SCRIPT_PARAMS],
  capabilities: ['model.read'],
  reads: 'model',
  requires: { backend: ['sandbox'] },
  run: async (ctx, inputs, params) => {
    const value = await evaluate(ctx, inputs, params);
    // An `items` port hands its value straight to downstream list ports; a
    // non-array here would reach them as a list-shaped value that is not one.
    if (!Array.isArray(value)) throw new Error(`script.list must end in an array, got ${value === null ? 'null' : typeof value}`);
    return { items: value };
  },
};
