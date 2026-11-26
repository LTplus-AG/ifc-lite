#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build the MCP Registry `server.json`, the Claude Desktop bundle
 * (`ifc-lite-<version>.mcpb`) and its resolved dependency list
 * (`ifc-lite-<version>.deps.txt`) for the current @ifc-lite/mcp version.
 *
 *   pnpm --filter @ifc-lite/mcp release:manifests [--out <dir>] [--no-bundle]
 *
 * The script first builds @ifc-lite/mcp and every workspace package it
 * depends on, the wasm runtime included, with turbo's cache off (a cached
 * soft-skip could restore an old runtime), so nothing in the bundle is stale.
 * It refuses to bundle without wasm-pack (build-wasm.sh would keep whatever
 * runtime is on disk), and fails if a runtime is missing from the stage.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BUNDLE_SERVER_DIR, mcpbManifest, serverJson } from '../dist/release/manifests.js';

/** Pinned so a new CLI release cannot change what a release builds. */
const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const { values: flags } = parseArgs({ options: { out: { type: 'string' }, 'no-bundle': { type: 'boolean' } } });
// pnpm runs scripts in packages/mcp; a relative --out means where the user typed it.
const userCwd = process.env.npm_lifecycle_event === 'release:manifests' ? (process.env.INIT_CWD ?? process.cwd()) : process.cwd();
const out = flags.out ? resolve(userCwd, flags.out) : join(pkgDir, 'release-out');
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

/**
 * Every package in a hoisted node_modules: name@version mapped to the folder
 * of each copy, since a version can sit nested under another package.
 */
function resolvedTree(nodeModules) {
  const found = new Map();
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith('@')) { visit(path); continue; }
      const manifest = join(path, 'package.json');
      if (existsSync(manifest)) {
        const { name, version } = JSON.parse(readFileSync(manifest, 'utf-8'));
        const spec = `${name}@${version}`;
        found.set(spec, [...(found.get(spec) ?? []), path]);
      }
      if (existsSync(join(path, 'node_modules'))) visit(join(path, 'node_modules'));
    }
  };
  visit(nodeModules);
  return found;
}

/**
 * The root `patchedDependencies` the stage carries, each checked to be applied:
 * the hoisted deploy runs with allow-unused-patches, so pnpm would not say if
 * one of them were skipped. Every line a patch adds must be in the staged file.
 */
const nameOf = (spec) => spec.slice(0, spec.lastIndexOf('@'));

/** A patch as files, each with the lines it adds and the lines it only removes. */
function parsePatch(text) {
  const files = [];
  // A CRLF checkout of patches/ (core.autocrlf) must still compare equal.
  let prev = '';
  for (const line of text.split(/\r?\n/)) {
    // A file header is `+++ ` right after `--- `; inside a hunk it is an added `++ ` line.
    const header = line.startsWith('+++ ') && prev.startsWith('--- ');
    prev = line;
    if (header) {
      // A deleted file (+++ /dev/null) has nothing to look for.
      files.push({ name: line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, ''), added: [], removed: [] });
    } else if (files.length && line.startsWith('+') && line.trim() !== '+') files.at(-1).added.push(line.slice(1));
    else if (files.length && line.startsWith('-') && !line.startsWith('--- ') && line.trim() !== '-') files.at(-1).removed.push(line.slice(1));
  }
  // A removed line that lives on inside an added one (`f(x)` -> `f(x, y)`) proves nothing.
  for (const f of files) f.removed = f.removed.filter((l) => !f.added.some((a) => a.includes(l)));
  return files.filter((f) => f.name !== null);
}

function assertPatchesApplied(staged) {
  const root = resolve(pkgDir, '..', '..');
  const patches = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).pnpm?.patchedDependencies ?? {};
  for (const [spec, patch] of Object.entries(patches)) {
    if (!/^.+@\d+\.\d+\.\d+/.test(spec)) {
      throw new Error(`patchedDependencies key ${spec} is not name@x.y.z; this check matches exact versions only`);
    }
    // pnpm patches one version; any other version of the package ships unpatched.
    const other = [...staged.keys()].find((s) => nameOf(s) === nameOf(spec) && s !== spec);
    if (other) throw new Error(`${other} is staged, but ${patch} only patches ${spec}`);
    const files = parsePatch(readFileSync(join(root, patch), 'utf-8'));
    // A patch that parsed to nothing would pass without having checked anything.
    if (!files.some((f) => f.added.length)) throw new Error(`${patch} has no added lines to check`);
    // Every copy of exactly this version, hoisted or nested.
    for (const pkgRoot of staged.get(spec) ?? []) {
      for (const { name, added, removed } of files) {
        const text = readFileSync(join(pkgRoot, name), 'utf-8');
        const missing = added.find((l) => !text.includes(l));
        if (missing !== undefined) throw new Error(`${pkgRoot}/${name} is staged without ${patch} (missing: ${missing.trim()})`);
        // Added lines can be generic (`}`), so a line the patch only removes must
        // also be gone, compared as a whole line.
        const present = new Set(text.split(/\r?\n/).map((l) => l.trim()));
        if (removed.length && removed.every((l) => present.has(l.trim()))) {
          throw new Error(`${pkgRoot}/${name} still has every line ${patch} removes`);
        }
      }
    }
  }
}

/** The newest modification time of a .rs or Cargo file under `dir`. */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else if (/\.rs$|^Cargo\.(toml|lock)$/.test(entry.name)) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

function missingWasm(root) {
  return WASM.filter((f) => !existsSync(join(root, f)));
}

const win = process.platform === 'win32';

/** On Windows pnpm and npx are .cmd shims, which need the shell; quote for it. */
function run(command, args, cwd) {
  const r = spawnSync(command, win ? args.map((a) => `"${a}"`) : args, { cwd, stdio: 'inherit', shell: win });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${r.status ?? r.signal}`);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'server.json'), `${JSON.stringify(serverJson(pkg), null, 2)}\n`);
process.stdout.write(`wrote ${join(out, 'server.json')}\n`);
// The registry verifies ownership through the npm package's mcpName.
const onNpm = spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'mcpName'], { encoding: 'utf-8', shell: win, timeout: 30_000 });
if (onNpm.status !== 0 && /E404/.test(onNpm.stderr ?? '')) {
  process.stdout.write(`note: ${pkg.name}@${pkg.version} is not on npm yet; publish it before server.json\n`);
} else if (onNpm.status !== 0) {
  process.stdout.write(`note: could not ask npm about ${pkg.name}@${pkg.version}; check its mcpName before publishing server.json\n`);
} else if (onNpm.stdout.trim() !== pkg.mcpName) {
  process.stdout.write(`note: ${pkg.name}@${pkg.version} on npm has no mcpName ${pkg.mcpName}; publish this version before server.json\n`);
}

if (!flags['no-bundle']) {
  // build-wasm.sh keeps the runtime on disk when wasm-pack is missing, so a
  // release host without it would bundle an old engine.
  // The same two places build-wasm.sh looks.
  const cargoWasmPack = join(homedir(), '.cargo', 'bin', win ? 'wasm-pack.exe' : 'wasm-pack');
  if (spawnSync('wasm-pack', ['--version'], { shell: win }).status !== 0 && !existsSync(cargoWasmPack)) {
    throw new Error('wasm-pack is not installed: a release must rebuild the wasm runtime (scripts/build-wasm.sh)');
  }
  // Checked before the slow deploy, and again in the stage after it.
  const source = missingWasm(resolve(pkgDir, '..', 'wasm'));
  if (source.length) throw new Error(`packages/wasm is missing ${source.join(', ')}: build it (scripts/build-wasm.sh) first`);
  // A folder this script owns: --out may already hold a user's own `mcpb`.
  const stage = join(out, '.ifc-lite-mcpb-stage');
  const deps = join(out, `ifc-lite-${pkg.version}.deps.txt`);
  const bundle = join(out, `ifc-lite-${pkg.version}.mcpb`);
  // A failed rebuild must not leave the last run's bundle looking current.
  for (const old of [deps, bundle]) rmSync(old, { force: true });
  rmSync(stage, { recursive: true, force: true });
  run('pnpm', [
    '--config.node-linker=hoisted',
    // Root patches name packages the server does not depend on; hoisted deploy
    // refuses unused patches unless told otherwise.
    '--config.allow-unused-patches=true',
    '--filter', pkg.name, 'deploy', '--prod', '--legacy', join(stage, BUNDLE_SERVER_DIR),
  ], pkgDir);
  pruneStage(join(stage, BUNDLE_SERVER_DIR));
  // build-wasm.sh keeps the old runtime when a wasm-pack build fails outside CI,
  // so a runtime older than the Rust sources is a stale one.
  const rustNewest = newestMtime(resolve(pkgDir, '..', '..', 'rust'));
  const stale = WASM.filter((f) => statSync(resolve(pkgDir, '..', 'wasm', f)).mtimeMs < rustNewest);
  if (stale.length) throw new Error(`packages/wasm/${stale.join(', ')} is older than the Rust sources: rebuild it (scripts/build-wasm.sh)`);
  const staged = missingWasm(join(stage, BUNDLE_SERVER_DIR, 'node_modules', '@ifc-lite', 'wasm'));
  if (staged.length) throw new Error(`the deployed stage is missing ${staged.join(', ')}`);
  // Hoisted deploy resolves within package.json ranges, not the lockfile, so the
  // exact tree is recorded next to the bundle to audit or reproduce a release.
  const nodeModules = join(stage, BUNDLE_SERVER_DIR, 'node_modules');
  const tree = resolvedTree(nodeModules);
  assertPatchesApplied(tree);
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(mcpbManifest(pkg), null, 2)}\n`);
  // Source maps and type declarations are about 30 MB of the stage and never run.
  // pnpm's state files hold this host's store paths and do nothing at runtime.
  writeFileSync(join(stage, '.mcpbignore'), '*.map\n*.d.ts\n*.d.mts\n*.d.cts\n.modules.yaml\n.pnpm-workspace-state*\n');
  run('npx', ['-y', MCPB_CLI, 'pack', stage, bundle], pkgDir);
  process.stdout.write(`wrote ${bundle}\n`);
  // A few hundred MB, with its own copy of this package's package.json.
  rmSync(stage, { recursive: true, force: true });
  // Only once the bundle exists, so a failed pack leaves no record of a bundle.
  writeFileSync(deps, `${[...tree.keys()].sort().join('\n')}\n`);
  process.stdout.write(`wrote ${deps}\n`);
}
