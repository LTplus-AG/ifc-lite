/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The validators must run in a Cloudflare Worker: bundle every entry the way a
// Worker build does and fail on any Node built-in reaching it.
const NODE_BUILTIN = /^(node:|(assert|buffer|child_process|crypto|fs|module|os|path|process|stream|url|util|worker_threads|zlib)(\/|$))/;

async function nodeBuiltinsIn(entry: string): Promise<string[]> {
  const found: string[] = [];
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    format: 'esm',
    logLevel: 'silent',
    plugins: [{
      name: 'record-node-builtins',
      setup(b) {
        b.onResolve({ filter: NODE_BUILTIN }, (args) => {
          found.push(`${args.path} (from ${args.importer})`);
          return { path: args.path, external: true };
        });
      },
    }],
  });
  return found;
}

describe('@ifc-lite/validate bundles for Workers', () => {
  it.each(['../src/index.ts', '../src/generated/ifc4/zod.ts', '../src/generated/ifc4x3/zod.ts'])(
    '%s pulls in no Node built-in',
    async (entry) => expect(await nodeBuiltinsIn(entry)).toEqual([]),
    60_000,
  );
});
