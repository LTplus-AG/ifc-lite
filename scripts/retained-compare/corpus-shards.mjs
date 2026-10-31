#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shard the downloaded model corpus for the nightly native comparison (#7955).
 *
 *   corpus-shards.mjs shard  --manifest M --shards N --index I --out FILE
 *   corpus-shards.mjs merge  --out products.tsv  shard-0/products.tsv shard-1/products.tsv ...
 *
 * `shard` writes a manifest (same shape, `.ifc` files only) for shard I of N,
 * to be read by `retained_compare --manifest`. Assignment is deterministic:
 * largest file first onto the currently lightest shard (ties by path), so a
 * rerun of the same manifest produces the same shards and the shards are
 * balanced by bytes. Every `.ifc` lands in exactly one shard.
 *
 * `merge` concatenates per-shard products.tsv files under their common header
 * and refuses differing headers, so the browser corpus reads one table.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

export function shardFiles(files, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, got ${count}`);
  const ifc = files.filter((f) => typeof f?.path === 'string' && f.path.toLowerCase().endsWith('.ifc'));
  if (ifc.length === 0) throw new Error('manifest has no .ifc files to shard');
  const ordered = [...ifc].sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ bytes: 0, files: [] }));
  for (const file of ordered) {
    const lightest = shards.reduce((best, s, i) => (s.bytes < shards[best].bytes ? i : best), 0);
    shards[lightest].files.push(file);
    shards[lightest].bytes += file.size ?? 0;
  }
  return shards.map((s) => s.files.sort((a, b) => (a.path < b.path ? -1 : 1)));
}

export function mergeProducts(tables) {
  if (tables.length === 0) throw new Error('no products.tsv files to merge');
  const split = tables.map((t) => t.replace(/\n+$/, '').split('\n'));
  const [header] = split[0];
  const rows = [];
  for (const [i, lines] of split.entries()) {
    if (lines[0] !== header) throw new Error(`products.tsv #${i} has a different header`);
    rows.push(...lines.slice(1).filter(Boolean));
  }
  return `${[header, ...rows].join('\n')}\n`;
}

function flags(argv, allowed) {
  const out = { rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (!allowed.includes(key) || argv[i + 1] === undefined) throw new Error(`unknown or incomplete flag ${argv[i]}`);
      out[key] = argv[++i];
    } else out.rest.push(argv[i]);
  }
  return out;
}

export function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'shard') {
    const o = flags(rest, ['manifest', 'shards', 'index', 'out']);
    for (const k of ['manifest', 'shards', 'index', 'out']) if (!o[k]) throw new Error(`--${k} is required`);
    const count = Number(o.shards);
    const index = Number(o.index);
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`--index must be 0..${count - 1}, got ${o.index}`);
    const manifest = JSON.parse(readFileSync(o.manifest, 'utf8'));
    const files = shardFiles(manifest.files ?? [], count)[index];
    if (files.length === 0) throw new Error(`shard ${index}/${count} is empty; use fewer shards than models`);
    writeFileSync(o.out, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`);
    return `shard ${index}/${count}: ${files.length} models, ${files.reduce((s, f) => s + (f.size ?? 0), 0)} bytes`;
  }
  if (command === 'merge') {
    const o = flags(rest, ['out']);
    if (!o.out) throw new Error('--out is required');
    writeFileSync(o.out, mergeProducts(o.rest.map((f) => readFileSync(f, 'utf8'))));
    return `merged ${o.rest.length} products.tsv files`;
  }
  throw new Error('Usage: corpus-shards.mjs shard|merge ...');
}

if (isMainEntry(import.meta.url)) {
  try { console.log(main(process.argv.slice(2))); }
  catch (error) { console.error(`❌ corpus-shards: ${error.message}`); process.exit(1); }
}
