/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7543: three builds of @ifc-lite/ids that differ only in the three
// production files of the change.
//
//   node docs/architecture/evidence/7543-boolean-one-zero/make-builds.mjs <out dir> <main ref>
//
// Each build is this checkout's packages/ids (package.json, tsconfig.json and
// src), compiled with the package's own TypeScript into <out dir>/<name>/dist:
//
//   head       this checkout as it is;
//   20e2a5d6b  the same, with the three files as they are at 20e2a5d6b;
//   main       the same, with the three files as they are at <main ref>.
//
// The three files are packages/ids/src/constraints/comparators.ts,
// xsd-cast.ts and xsd-lexical.ts. Each build also gets:
// - node_modules, a link to packages/ids/node_modules, so all three load the
//   same @ifc-lite/parser and other dependencies;
// - a copy of boolean-one-zero.mjs (the script from #7543), which then
//   imports that build by its package name.
//
// <out dir>/<name> must not exist yet. Nothing is deleted.

import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const IDS = join(REPO, 'packages', 'ids');
const FILES = ['comparators.ts', 'xsd-cast.ts', 'xsd-lexical.ts'];

const [out, mainRef] = process.argv.slice(2);
if (!out || !mainRef) {
  console.error('usage: node make-builds.mjs <out dir> <main ref>');
  process.exit(2);
}
const tsc = createRequire(join(IDS, 'package.json')).resolve('typescript/bin/tsc');

for (const [name, ref] of [['head', undefined], ['20e2a5d6b', '20e2a5d6b'], ['main', mainRef]]) {
  const dir = resolve(out, name);
  if (existsSync(dir)) throw new Error(`${name}: the folder exists already; give a new <out dir>`);
  mkdirSync(dir, { recursive: true });
  cpSync(join(IDS, 'package.json'), join(dir, 'package.json'));
  cpSync(join(IDS, 'tsconfig.json'), join(dir, 'tsconfig.json'));
  cpSync(join(IDS, 'src'), join(dir, 'src'), { recursive: true });
  if (ref) {
    for (const f of FILES) {
      const text = execFileSync('git', ['show', `${ref}:packages/ids/src/constraints/${f}`], { cwd: REPO });
      writeFileSync(join(dir, 'src', 'constraints', f), text);
    }
  }
  // 'junction' is used on Windows only; elsewhere this is a directory symlink.
  symlinkSync(join(IDS, 'node_modules'), join(dir, 'node_modules'), 'junction');
  execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { stdio: 'inherit' });
  cpSync(join(HERE, 'boolean-one-zero.mjs'), join(dir, 'boolean-one-zero.mjs'));
  console.log(`${name}: built, ${ref ? `with ${ref}'s ${FILES.join(', ')}` : 'no file replaced'}`);
}
