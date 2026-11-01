#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shard the downloaded model corpus for the nightly native comparison (#7955).
 *
 *   corpus-shards.mjs shard  --manifest M --shards N --index I --out FILE [--exclusions FILE]
 *   corpus-shards.mjs merge  --shards N --out products.tsv  shard-0/products.tsv shard-1/products.tsv ...
 *
 * `shard` writes a manifest (same shape, `.ifc` files only) for shard I of N,
 * to be read by `retained_compare --manifest`. Assignment is deterministic:
 * largest file first onto the currently lightest shard (ties by path), so a
 * rerun of the same manifest produces the same shards and the shards are
 * balanced by bytes. Every `.ifc` lands in exactly one shard, except the declared
 * exclusions below.
 *
 * Models listed in corpus-exclusions.json (path, reason, evidence) are left out of
 * every shard on purpose, and `excluded` reports them as NOT CHECKED (a workflow
 * warning and the job summary) so that a green nightly never reads as covering them.
 * An exclusion naming a path absent from the manifest, or without a reason or
 * evidence, is an error: a stale or unexplained entry must not hide a model.
 *
 *   corpus-shards.mjs excluded --manifest M
 *
 * `merge` concatenates per-shard products.tsv files under their common header
 * and refuses differing headers, so the browser corpus reads one table.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const DEFAULT_EXCLUSIONS = new URL('./corpus-exclusions.json', import.meta.url);

/** Split manifest files into those to check and those excluded on purpose; refuses stale or unexplained entries. */
export function applyExclusions(files, exclusions) {
  if (!Array.isArray(exclusions)) throw new Error('exclusions must be an array of { path, reason, evidence }');
  const known = new Set(files.map((f) => f?.path));
  const seen = new Set();
  for (const entry of exclusions) {
    for (const key of ['path', 'reason', 'evidence']) {
      if (typeof entry?.[key] !== 'string' || entry[key].trim() === '') throw new Error(`an exclusion needs a non-empty ${key}: ${JSON.stringify(entry)}`);
    }
    if (!known.has(entry.path)) throw new Error(`exclusion ${entry.path} is not in the manifest; remove the stale entry or fix the path`);
    if (seen.has(entry.path)) throw new Error(`exclusion ${entry.path} is listed twice`);
    seen.add(entry.path);
  }
  return { kept: files.filter((f) => !seen.has(f?.path)), excluded: exclusions };
}

function loadExclusions(file) {
  return JSON.parse(readFileSync(file ?? DEFAULT_EXCLUSIONS, 'utf8')).excluded;
}

/** The report the aggregate prints: each excluded model, why, and the evidence, as workflow warnings plus markdown. */
export function exclusionReport(excluded) {
  if (excluded.length === 0) return { warnings: [], markdown: '' };
  const warnings = excluded.map((e) => `::warning title=native corpus model NOT CHECKED::${e.path} is excluded from the corpus comparison and was not compared: ${e.reason} Evidence: ${e.evidence}`.replace(/\r?\n/g, ' '));
  const rows = excluded.map((e) => `| \`${e.path}\` | ${e.reason} | ${e.evidence} |`);
  const markdown = `### Native corpus: ${excluded.length} model${excluded.length === 1 ? '' : 's'} NOT CHECKED\n\nA green result below covers every other model only.\n\n| Model | Why | Evidence |\n| --- | --- | --- |\n${rows.join('\n')}\n`;
  return { warnings, markdown };
}

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
    const o = flags(rest, ['manifest', 'shards', 'index', 'out', 'exclusions']);
    for (const k of ['manifest', 'shards', 'index', 'out']) if (!o[k]) throw new Error(`--${k} is required`);
    const count = Number(o.shards);
    const index = Number(o.index);
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`--index must be 0..${count - 1}, got ${o.index}`);
    const manifest = JSON.parse(readFileSync(o.manifest, 'utf8'));
    const { kept, excluded } = applyExclusions(manifest.files ?? [], loadExclusions(o.exclusions));
    const files = shardFiles(kept, count)[index];
    if (files.length === 0) throw new Error(`shard ${index}/${count} is empty; use fewer shards than models`);
    writeFileSync(o.out, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`);
    return `shard ${index}/${count}: ${files.length} models, ${files.reduce((s, f) => s + (f.size ?? 0), 0)} bytes${excluded.length ? ` (${excluded.length} excluded model${excluded.length === 1 ? '' : 's'} not in any shard)` : ''}`;
  }
  if (command === 'excluded') {
    const o = flags(rest, ['manifest', 'exclusions']);
    if (!o.manifest) throw new Error('--manifest is required');
    const manifest = JSON.parse(readFileSync(o.manifest, 'utf8'));
    const { excluded } = applyExclusions(manifest.files ?? [], loadExclusions(o.exclusions));
    const { warnings, markdown } = exclusionReport(excluded);
    for (const w of warnings) console.log(w);
    if (markdown && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    return excluded.length ? `${excluded.length} model${excluded.length === 1 ? '' : 's'} NOT CHECKED: ${excluded.map((e) => e.path).join(', ')}` : 'no models excluded';
  }
  if (command === 'merge') {
    const o = flags(rest, ['out', 'shards']);
    for (const k of ['out', 'shards']) if (!o[k]) throw new Error(`--${k} is required`);
    // A shard with a summary but no table would otherwise merge away silently.
    if (o.rest.length !== Number(o.shards)) throw new Error(`expected ${o.shards} products.tsv files, got ${o.rest.length}`);
    writeFileSync(o.out, mergeProducts(o.rest.map((f) => readFileSync(f, 'utf8'))));
    return `merged ${o.rest.length} products.tsv files`;
  }
  throw new Error('Usage: corpus-shards.mjs shard|excluded|merge ...');
}

if (isMainEntry(import.meta.url)) {
  try { console.log(main(process.argv.slice(2))); }
  catch (error) { console.error(`❌ corpus-shards: ${error.message}`); process.exit(1); }
}
