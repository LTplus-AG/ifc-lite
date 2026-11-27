/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Worker } from 'node:worker_threads';
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
  it.each(['../src/index.ts', '../src/generated/ifc2x3/zod.ts', '../src/generated/ifc4/zod.ts', '../src/generated/ifc4x3/zod.ts'])(
    '%s pulls in no Node built-in',
    async (entry) => expect(await nodeBuiltinsIn(entry)).toEqual([]),
    60_000,
  );
});

it('executes STEP validation inside a Worker using the browser bundle (#11560)', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    bundle: true, platform: 'browser', format: 'iife', globalName: 'validator', write: false,
  });
  const worker = new Worker(result.outputFiles[0].text + `
    const { parentPort } = require('node:worker_threads');
    validator.validateStepText("HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#7=IFCUNKNOWN();ENDSEC;")
      .then(report => parentPort.postMessage(report.findings.some(f => f.instance === 7 && f.rule === 'unknown-entity')));
  `, { eval: true });
  try {
    await expect(new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    })).resolves.toBe(true);
  } finally {
    await worker.terminate();
  }
}, 60_000);
