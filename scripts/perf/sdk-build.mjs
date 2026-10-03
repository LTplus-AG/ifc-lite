/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { endpointConfig } from './sdk-client/vite-config.mts';
import { immutableRef } from './interleaved-plan.mjs';
const [sourceArgument, headArgument, outputArgument] = process.argv.slice(2);
const head = immutableRef(headArgument);
if (!sourceArgument || !outputArgument) throw new Error('source/head/new output required');
const source = resolve(sourceArgument), output = resolve(outputArgument);
if (existsSync(output) || output.startsWith(`${source}/`)) throw new Error('new output outside source required');
function sourceGate() {
  if (execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== head
    || execFileSync('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) {
    throw new Error('immutable clean source required');
  }
}
sourceGate();
const requireFromViewer = createRequire(join(source, 'apps/viewer/package.json'));
const load = name => import(pathToFileURL(requireFromViewer.resolve(name)).href);
const [{ build }, { default: wasm }, { default: topLevelAwait }] = await Promise.all([
  load('vite'), load('vite-plugin-wasm'), load('vite-plugin-top-level-await'),
]);
await build(endpointConfig(source, resolve(import.meta.dirname, 'sdk-client'), output, wasm, topLevelAwait));
sourceGate();
