#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build a blind council packet from two captures (#8802).
 *
 *   node tests/ui-scenes/pair.mjs --a <candidate capture> --b <reference capture> \
 *     --out <packet dir> --key <key.json> [--controls 2] [--seed <n>] [--partial]
 *   node tests/ui-scenes/pair.mjs --solo <capture> --out <packet dir> --key <key.json>
 *
 * Each scene/theme becomes an item with images `X` and `Y`; which capture is
 * X is re-drawn per item, so a reviewer can't learn "X is the new one".
 * `--controls` adds items whose X and Y are the SAME reference screenshot: a
 * reviewer who prefers one of two identical images is inventing differences,
 * and the tally reports that as its control accuracy.
 *
 * The packet holds only images, `items.json` and the council brief. The key
 * (which side is which, and both manifests' metrics) is written OUTSIDE the
 * packet; never give its path to a reviewer.
 *
 * @unwired-by-design council tooling, run by hand between rounds; not a CI gate.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { controls: 2, seed: Date.now() };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--partial') { args.partial = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${key} needs a value`);
    if (key === '--a') args.a = resolve(v);
    else if (key === '--b') args.b = resolve(v);
    else if (key === '--solo') args.solo = resolve(v);
    else if (key === '--out') args.out = resolve(v);
    else if (key === '--key') args.key = resolve(v);
    else if (key === '--controls') args.controls = Number(v);
    else if (key === '--seed') args.seed = Number(v);
    else throw new Error(`unknown argument ${key}`);
  }
  for (const name of ['controls', 'seed']) {
    if (!Number.isSafeInteger(args[name]) || args[name] < 0) throw new Error(`--${name} must be a non-negative integer`);
  }
  if (!args.out || !args.key || !(args.solo || (args.a && args.b))) {
    throw new Error('usage: pair.mjs (--a <dir> --b <dir> | --solo <dir>) --out <packet> --key <key.json>');
  }
  if (!relative(args.out, args.key).startsWith('..')) throw new Error('--key must be outside the packet directory');
  return args;
}

/** mulberry32: a seeded PRNG so a packet can be rebuilt identically from its key. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function manifest(dir) {
  const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (m.failures?.length) throw new Error(`${dir} has ${m.failures.length} failed scenes; recapture before reviewing`);
  return m;
}

const itemId = (r) => `${r.scene}.${r.theme}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const random = rng(args.seed);
  await mkdir(args.out, { recursive: true });
  await copyFile(join(HERE, 'COUNCIL.md'), join(args.out, 'COUNCIL.md'));

  const items = [];
  const key = { version: 1, seed: args.seed, mode: args.solo ? 'solo' : 'pair', ...(args.partial ? { partial: true } : {}), items: {} };

  if (args.solo) {
    const m = await manifest(args.solo);
    key.solo = { dir: args.solo, label: m.label };
    for (const r of m.results) {
      const x = `${itemId(r)}.X.png`;
      await copyFile(join(args.solo, r.file), join(args.out, x));
      items.push({ scene: r.scene, theme: r.theme, title: r.title, x });
      key.items[itemId(r)] = { x: 'solo', metrics: { solo: r.metrics } };
    }
  } else {
    const [ma, mb] = await Promise.all([manifest(args.a), manifest(args.b)]);
    key.a = { dir: args.a, label: ma.label };
    key.b = { dir: args.b, label: mb.label };
    const byId = new Map(mb.results.map((r) => [itemId(r), r]));
    const aIds = new Set(ma.results.map(itemId));
    const missingA = mb.results.map(itemId).filter((id) => !aIds.has(id));
    const missingB = ma.results.map(itemId).filter((id) => !byId.has(id));
    if (!args.partial && (missingA.length || missingB.length)) {
      throw new Error(`capture item sets differ; missing in A: ${missingA.join(', ') || 'none'}; missing in B: ${missingB.join(', ') || 'none'}; use --partial for a diagnostic packet`);
    }
    for (const ra of ma.results) {
      const rb = byId.get(itemId(ra));
      if (!rb) continue;
      const aIsX = random() < 0.5;
      const x = `${itemId(ra)}.X.png`; const y = `${itemId(ra)}.Y.png`;
      await copyFile(join(aIsX ? args.a : args.b, (aIsX ? ra : rb).file), join(args.out, x));
      await copyFile(join(aIsX ? args.b : args.a, (aIsX ? rb : ra).file), join(args.out, y));
      items.push({ scene: ra.scene, theme: ra.theme, title: ra.title, x, y });
      key.items[itemId(ra)] = { x: aIsX ? 'a' : 'b', metrics: { a: ra.metrics, b: rb.metrics }, pageErrors: { a: ra.pageErrors, b: rb.pageErrors } };
    }
    const pool = [...mb.results];
    for (let c = 0; c < args.controls && pool.length > 0; c++) {
      const r = pool.splice(Math.floor(random() * pool.length), 1)[0];
      // Controls are named like real items (a "-c" scene suffix would give them away).
      const id = `${r.scene}-${c + 2}.${r.theme}`;
      const x = `${id}.X.png`; const y = `${id}.Y.png`;
      await copyFile(join(args.b, r.file), join(args.out, x));
      await copyFile(join(args.b, r.file), join(args.out, y));
      items.push({ scene: `${r.scene}-${c + 2}`, theme: r.theme, title: r.title, x, y });
      key.items[id] = { x: 'control', control: true };
    }
  }

  // Shuffle so controls and themes are not in a recognisable position.
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  await writeFile(join(args.out, 'items.json'), `${JSON.stringify({ mode: key.mode, items }, null, 2)}\n`);
  await mkdir(dirname(args.key), { recursive: true });
  await writeFile(args.key, `${JSON.stringify(key, null, 2)}\n`);
  console.log(`${items.length} items -> ${args.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
