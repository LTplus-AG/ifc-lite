#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sysrootInputs } from './exact-route-externs.mjs';
import { sha256 } from './exact-route-source.mjs';
import { cargoConfiguration, compilerOutputs, digest, directoryInputs, packageInputs } from './exact-route-inputs.mjs';
const [compiler, ...args] = process.argv.slice(2), cwd = process.cwd();
if (!compiler || !process.env.EXACT_ROUTE_RUSTC_LOG || !process.env.EXACT_ROUTE_CONTEXT_FILE) throw Error('missing compiler evidence context');
const contextBytes = readFileSync(process.env.EXACT_ROUTE_CONTEXT_FILE), context = JSON.parse(contextBytes);
if (context.workspaceRoot !== cwd) throw Error('compiler cwd differs from compile context');
const identity = spawnSync(compiler, ['-vV'], { encoding: 'utf8' });
if (identity.error || identity.status !== 0) throw Error('cannot identify actual compiler');
const pkg = process.env.CARGO_MANIFEST_DIR && process.env.CARGO_PKG_NAME && process.env.CARGO_PKG_VERSION ?
  { root: resolve(process.env.CARGO_MANIFEST_DIR), name: process.env.CARGO_PKG_NAME, version: process.env.CARGO_PKG_VERSION } : null;
const externs = () => Object.fromEntries(args.flatMap((arg, i) => {
  if (arg !== '--extern') return [];
  const split = args[i + 1]?.indexOf('=');
  if (!(split > 0)) { if (args[i + 1] === 'proc_macro') return []; throw Error('unbound compiler extern input'); }
  const path = resolve(cwd, args[i + 1].slice(split + 1)); return [[path, sha256(readFileSync(path))]];
}));
const sysrootExternsBefore = sysrootInputs(compiler, args);
const inputsBefore = pkg ? packageInputs(pkg.root) : null;
const generatedRoot = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : null;
const generatedInputsBefore = generatedRoot ? directoryInputs(generatedRoot) : null;
const configurationBefore = cargoConfiguration(cwd), externInputs = externs();
const result = spawnSync(compiler, args, { stdio: 'inherit' });
const event = { compiler, version: identity.stdout.trim(), args, cwd, package: pkg,
  contextSha256: digest(context), status: result.status, signal: result.signal,
  generatedRoot, generatedInputsBefore, generatedInputsAfter: generatedRoot ? directoryInputs(generatedRoot) : null,
  inputsBefore, inputsAfter: pkg ? packageInputs(pkg.root) : null,
  sysrootExternsBefore, sysrootExternsAfter: sysrootInputs(compiler, args),
  configurationBefore, configurationAfter: cargoConfiguration(cwd), externInputs, externAfter: externs(),
  outputs: result.status === 0 ? compilerOutputs(args, cwd) : {} };
appendFileSync(process.env.EXACT_ROUTE_RUSTC_LOG, `${JSON.stringify(event)}\n`);
if (result.error) throw result.error;
if (result.signal) { console.error(`compiler terminated: ${result.signal}`); process.exit(1); }
process.exit(result.status ?? 1);
