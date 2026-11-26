#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build the MCP Registry `server.json` and the Claude Desktop bundle
 * (`ifc-lite-<version>.mcpb`) for the current @ifc-lite/mcp version.
 *
 *   pnpm --filter @ifc-lite/mcp release:manifests [--out <dir>] [--no-bundle]
 *
 * The script first builds @ifc-lite/mcp and every workspace package it
 * depends on, the wasm runtime included, so nothing in the bundle is stale.
 * Run it on a host with Rust and wasm-pack: without them build-wasm.sh keeps
 * whatever runtime is on disk. The bundle step fails if a runtime is missing.
 *
 * Publish server.json (mcp-publisher publish) only once this version is on
 * npm: the registry checks the npm package's mcpName.
 *
 * The bundle stages the package with its production dependencies through
 * `pnpm deploy`, writes the manifest next to it and packs it with the
 * official `mcpb` CLI, which validates the manifest first.
 *
 * The stage is a hoisted (npm-style) node_modules of real files: `mcpb pack`
 * followed pnpm's symlinked store until it was killed. Hoisted deploy does
 * not read the workspace lockfile, so dependencies resolve within the
 * package.json ranges, as they do for anyone installing the npm package.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BUNDLE_SERVER_DIR, mcpbManifest, serverJson } from '../dist/release/manifests.js';

/** Pinned so a new CLI release cannot change what a release builds. */
const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const { values: flags } = parseArgs({ options: { out: { type: 'string' }, 'no-bundle': { type: 'boolean' } } });
const out = resolve(flags.out ?? join(pkgDir, 'release-out'));
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));

/**
 * `.bin` holds symlinks to CLIs the server never runs, so it goes. Any other
 * symlink is a build error: the bundle must carry real files only.
 */
function pruneStage(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.name === '.bin') rmSync(path, { recursive: true, force: true });
    else if (entry.isSymbolicLink()) throw new Error(`${path} is a symlink; the bundle needs real files`);
    else if (entry.isDirectory()) pruneStage(path);
  }
}

/**
 * The wasm runtimes, gitignored and built by scripts/build-wasm.sh: the core
 * one, plus those @ifc-lite/wasm/diff and /rhino load. Without them no model loads.
 */
const WASM = [join('pkg', 'ifc-lite_bg.wasm'), join('pkg-diff', 'ifc-lite-diff_bg.wasm'), join('pkg-rhino', 'ifc-lite-rhino_bg.wasm')];

function missingWasm(root) {
  return WASM.filter((f) => !existsSync(join(root, f)));
}

const win = process.platform === 'win32';

/** On Windows pnpm and npx are .cmd shims, which need the shell; quote for it. */
function run(command, args, cwd) {
  const r = spawnSync(command, win ? args.map((a) => `"${a}"`) : args, { cwd, stdio: 'inherit', shell: win });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${r.status}`);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'server.json'), `${JSON.stringify(serverJson(pkg), null, 2)}\n`);
process.stdout.write(`wrote ${join(out, 'server.json')}\n`);

if (!flags['no-bundle']) {
  // Checked before the slow deploy, and again in the stage after it.
  const source = missingWasm(resolve(pkgDir, '..', 'wasm'));
  if (source.length) throw new Error(`packages/wasm is missing ${source.join(', ')}: build it (scripts/build-wasm.sh) first`);
  const stage = join(out, 'mcpb');
  rmSync(stage, { recursive: true, force: true });
  run('pnpm', [
    '--config.node-linker=hoisted',
    // Root patches name packages the server does not depend on; hoisted deploy
    // refuses unused patches unless told otherwise.
    '--config.allow-unused-patches=true',
    '--filter', pkg.name, 'deploy', '--prod', '--legacy', join(stage, BUNDLE_SERVER_DIR),
  ], pkgDir);
  pruneStage(join(stage, BUNDLE_SERVER_DIR));
  const staged = missingWasm(join(stage, BUNDLE_SERVER_DIR, 'node_modules', '@ifc-lite', 'wasm'));
  if (staged.length) throw new Error(`the deployed stage is missing ${staged.join(', ')}`);
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(mcpbManifest(pkg), null, 2)}\n`);
  // Source maps and type declarations are about 30 MB of the stage and never run.
  writeFileSync(join(stage, '.mcpbignore'), '*.map\n*.d.ts\n*.d.mts\n*.d.cts\n');
  const bundle = join(out, `ifc-lite-${pkg.version}.mcpb`);
  run('npx', ['-y', MCPB_CLI, 'pack', stage, bundle], pkgDir);
  process.stdout.write(`wrote ${bundle}\n`);
}
