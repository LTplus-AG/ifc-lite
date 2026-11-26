#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build the MCP Registry `server.json` and the Claude Desktop bundle
 * (`ifc-lite-<version>.mcpb`) for the current @ifc-lite/mcp version.
 *
 *   pnpm --filter @ifc-lite/mcp build
 *   pnpm --filter @ifc-lite/mcp release:manifests [--out <dir>] [--no-bundle]
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
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_SERVER_DIR, mcpbManifest, serverJson } from '../dist/release/manifests.js';

/** Pinned so a new CLI release cannot change what a release builds. */
const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const outFlag = argv.indexOf('--out');
const out = resolve(outFlag >= 0 && argv[outFlag + 1] ? argv[outFlag + 1] : join(pkgDir, 'release-out'));
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));

/** `.bin` holds symlinks to CLIs the server never runs; a bundle carries real files only. */
function removeBinLinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === '.bin') rmSync(path, { recursive: true, force: true });
    else removeBinLinks(path);
  }
}

function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${r.status}`);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'server.json'), `${JSON.stringify(serverJson(pkg), null, 2)}\n`);
process.stdout.write(`wrote ${join(out, 'server.json')}\n`);

if (!argv.includes('--no-bundle')) {
  const stage = join(out, 'mcpb');
  rmSync(stage, { recursive: true, force: true });
  run('pnpm', [
    '--config.node-linker=hoisted',
    // Root patches name packages the server does not depend on; hoisted deploy
    // refuses unused patches unless told otherwise.
    '--config.allow-unused-patches=true',
    '--filter', pkg.name, 'deploy', '--prod', '--legacy', join(stage, BUNDLE_SERVER_DIR),
  ], pkgDir);
  removeBinLinks(join(stage, BUNDLE_SERVER_DIR));
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(mcpbManifest(pkg), null, 2)}\n`);
  const bundle = join(out, `ifc-lite-${pkg.version}.mcpb`);
  run('npx', ['-y', MCPB_CLI, 'pack', stage, bundle], pkgDir);
  process.stdout.write(`wrote ${bundle}\n`);
}
