#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Freeze numeric arbitrary font-size utilities until #5821 removes them. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareToBaseline } from './lib/count-ratchet.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'apps/viewer/src';
const FONT_SIZE = /(?<![\w-])text-\[(?:\d+(?:\.\d+)?)px\](?![\w-])/g;
const SOURCE_FILE = /\.(?:js|jsx|ts|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.[jt]sx?$/;

function fail(message) {
  console.error(`check-type-scale: ${message}`);
  process.exit(1);
}

function options(argv) {
  const out = { root: ROOT, baseline: null, update: false, allowRaise: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--baseline') {
      if (!argv[i + 1]) fail(`${arg} needs a path`);
      out[arg.slice(2)] = resolve(argv[++i]);
    } else if (arg === '--update') out.update = true;
    else if (arg === '--allow-raise') out.allowRaise = true;
    else fail(`unknown argument ${arg}`);
  }
  if (out.allowRaise && !out.update) fail('--allow-raise requires --update');
  out.baseline ??= join(out.root, 'scripts', 'type-scale-baseline.json');
  return out;
}

function scan(root) {
  const source = join(root, SOURCE);
  if (!existsSync(source)) fail(`missing source tree ${source}`);
  const counts = {};
  let files = 0;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files++;
        const count = [...readFileSync(path, 'utf8').matchAll(FONT_SIZE)].length;
        if (count > 0) counts[relative(root, path).split('\\').join('/')] = count;
      }
    }
  }
  walk(source);
  if (files === 0) fail(`no production source files under ${source}`);
  return { counts, files };
}

function baselineAt(path) {
  if (!existsSync(path)) fail(`missing baseline ${path}; run --update to create it`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`invalid baseline ${path}: ${error.message}`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' ||
      Object.values(parsed).some((count) => !Number.isInteger(count) || count < 1)) {
    fail(`invalid count rows in ${path}`);
  }
  return parsed;
}

const args = options(process.argv.slice(2));
const { counts, files } = scan(args.root);
const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

if (args.update) {
  if (existsSync(args.baseline)) {
    const { regressions } = compareToBaseline(counts, baselineAt(args.baseline));
    if (regressions.length && !args.allowRaise) {
      fail(`refusing to raise ${regressions.length} row(s); use --allow-raise only for a reviewed exception`);
    }
  }
  writeFileSync(args.baseline, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`check-type-scale: recorded ${total} arbitrary font sizes in ${Object.keys(counts).length} file(s)`);
  process.exit(0);
}

const { regressions, improvements } = compareToBaseline(counts, baselineAt(args.baseline));
for (const { key, count, allowed } of regressions) console.error(`increase: ${key}: ${allowed} -> ${count}`);
for (const { key, count, allowed } of improvements) console.error(`lower baseline: ${key}: ${allowed} -> ${count}`);
if (regressions.length || improvements.length) {
  fail(`${regressions.length} increase(s), ${improvements.length} stale row(s); replace text-[Npx] with the type scale, then run --update`);
}
console.log(`check-type-scale: OK (${files} production files, ${total} arbitrary font sizes across ${Object.keys(counts).length} files)`);
