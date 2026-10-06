#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measurer for the `bundle` perf-ratchet family (#6959). Reads a built engine
 * WASM and a built viewer `dist/`, and writes the measured JSON that
 * `perf-ratchet.mjs check|lower` consumes. It builds nothing: CI measures the
 * artifacts the `build` job already produced.
 *
 *   node scripts/perf-ratchet/measure-bundle.mjs [--wasm <file>] [--dist <dir>]
 *        [--out <file>] [--commit <sha>]
 *
 * Metrics:
 *   engine-wasm-brotli      brotli bytes of packages/wasm/pkg/ifc-lite_bg.wasm
 *   viewer-entry-js-brotli  brotli bytes of the viewer's main entry chunk
 *   viewer-eager-js-brotli  summed brotli bytes of every JS file index.html makes
 *                           the browser fetch before first paint (module
 *                           <script src> + modulepreload) (#7002)
 *   viewer-eager-js-chunks  how many JS files that is; a looser companion to the
 *                           byte metric, because a count moves with Vite's
 *                           chunk splitting even when the shipped bytes do not
 *
 * Both eager metrics read one list, `eagerJsFiles`, so they cannot disagree
 * about which files are eager.
 *
 * WHY BROTLI, NOT RAW. The perf ledger (scripts/perf/README.md) records that
 * wasm-opt passes can SHRINK raw bytes while GROWING the brotli transfer size,
 * and says to gate on brotli. Raw bytes are kept in `detail` for reference.
 * Brotli is quality 11 (the max, what a static host precompresses with) via
 * node's zlib, so the number depends only on the bytes and the node build.
 *
 * WHY index.html. It is the one artifact that states what the browser loads
 * eagerly; Vite lists the entry as `<script type="module" src>` and its
 * static imports as `<link rel="modulepreload">`. The entry is the single
 * module script with a `src`; zero or several is an error rather than a
 * guess, so a template change cannot silently measure the wrong file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FAMILY = 'bundle';

/** Brotli size at quality 11, the number the ratchet gates on. */
export function brotliSize(buf) {
  return brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  }).length;
}

/** Attribute map of one start tag's attribute text. Valueless attributes map to ''. */
export function parseAttributes(text) {
  const attrs = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let m;
  while ((m = re.exec(text)) !== null) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

/**
 * The eagerly loaded JS of a built index.html.
 *
 * @param {string} html
 * @returns {{ entry: string, eager: string[] }} URL paths as written in the HTML
 */
export function eagerScripts(html) {
  // Comments first: a commented-out tag is not a load.
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const entries = [];
  const eager = [];
  for (const m of text.matchAll(/<script\b([^>]*)>/gi)) {
    const a = parseAttributes(m[1]);
    if (a.src === undefined || a.src === '') continue;
    eager.push(a.src);
    if ((a.type ?? '').toLowerCase() === 'module') entries.push(a.src);
  }
  for (const m of text.matchAll(/<link\b([^>]*)>/gi)) {
    const a = parseAttributes(m[1]);
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('modulepreload') && a.href) eager.push(a.href);
  }
  if (entries.length !== 1) {
    throw new Error(`expected exactly one <script type="module" src> entry in index.html, found ${entries.length}` +
      (entries.length ? `: ${entries.join(', ')}` : ''));
  }
  return { entry: entries[0], eager: [...new Set(eager)] };
}

/** Resolve an index.html URL path to a file inside `dist`, refusing anything outside it. */
export function resolveAsset(dist, urlPath) {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(urlPath)) throw new Error(`eager script ${urlPath} is not a local asset`);
  const clean = urlPath.split(/[?#]/)[0].replace(/^\/+/, '');
  const file = resolve(dist, clean);
  const rel = relative(resolve(dist), file);
  if (rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error(`eager script ${urlPath} resolves outside ${dist}`);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`eager script ${urlPath} is not in ${dist} (looked for ${file})`);
  return file;
}

/**
 * The one discovery behind both eager-JS metrics: every JS file index.html
 * loads before first paint, as distinct files inside `dist`. Preloads of
 * non-JS assets (stylesheets, fonts) are not eager JS and are left out; two
 * links that name the same file count once, however they are spelled.
 *
 * @param {string} dist
 * @param {string} html contents of dist/index.html
 * @returns {{ entry: string, files: { url: string, file: string }[] }}
 */
export function eagerJsFiles(dist, html) {
  const { entry, eager } = eagerScripts(html);
  const files = [];
  const seen = new Set();
  for (const url of eager) {
    if (!/\.m?js$/i.test(url.split(/[?#]/)[0])) continue;
    const file = resolveAsset(dist, url);
    if (seen.has(file)) continue;
    seen.add(file);
    files.push({ url, file });
  }
  return { entry, files };
}

/**
 * @param {{ wasm: string, dist: string, commit: string, measuredAt?: string }} opts
 */
export function measureBundle({ wasm, dist, commit, measuredAt = new Date().toISOString() }) {
  if (!existsSync(wasm)) throw new Error(`engine wasm not found at ${wasm} (build it: pnpm build:wasm)`);
  const indexHtml = join(dist, 'index.html');
  if (!existsSync(indexHtml)) throw new Error(`viewer build not found: no ${indexHtml} (build it: pnpm build:e2e)`);

  const wasmBytes = readFileSync(wasm);
  const { entry, files: jsEager } = eagerJsFiles(dist, readFileSync(indexHtml, 'utf8'));
  const eagerBytes = jsEager.map(({ file }) => readFileSync(file));
  const eagerRaw = eagerBytes.reduce((n, b) => n + b.length, 0);
  const entryBytes = readFileSync(resolveAsset(dist, entry));

  return {
    family: FAMILY,
    commit,
    measuredAt,
    metrics: [
      { id: 'engine-wasm-brotli', value: brotliSize(wasmBytes), detail: `raw ${wasmBytes.length} bytes` },
      { id: 'viewer-entry-js-brotli', value: brotliSize(entryBytes), detail: `${entry.split(/[?#]/)[0].replace(/^.*\//, '')}, raw ${entryBytes.length} bytes` },
      { id: 'viewer-eager-js-brotli', value: eagerBytes.reduce((n, b) => n + brotliSize(b), 0), detail: `${jsEager.length} files, raw ${eagerRaw} bytes, each file compressed on its own` },
      { id: 'viewer-eager-js-chunks', value: jsEager.length, detail: jsEager.map(({ url }) => url.replace(/^.*\//, '')).join(' ') },
    ],
  };
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`cannot read the commit to stamp (pass --commit): ${err.message}`);
  }
}

export function parseArgs(argv) {
  const opts = {
    wasm: join(ROOT, 'packages/wasm/pkg/ifc-lite_bg.wasm'),
    dist: join(ROOT, 'apps/viewer/dist'),
    out: null,
    commit: process.env.GITHUB_SHA || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = argv[++i];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--wasm') opts.wasm = resolve(v);
    else if (flag === '--dist') opts.dist = resolve(v);
    else if (flag === '--out') opts.out = resolve(v);
    else if (flag === '--commit') opts.commit = v;
    else throw new Error(`unknown option ${flag}`);
  }
  return opts;
}

if (isMainEntry(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = measureBundle({ ...opts, commit: opts.commit ?? gitHead() });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (opts.out) {
      mkdirSync(dirname(opts.out), { recursive: true });
      writeFileSync(opts.out, json);
    }
    process.stdout.write(json);
  } catch (err) {
    console.error(`measure-bundle: ${err.message}`);
    process.exitCode = 2;
  }
}
