/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The production source maps must still describe the code that ships after
// vite-plugin-top-level-await rewrites a chunk.
//
// That plugin re-prints every chunk it wraps (anything with a top-level await
// or a dynamic import, which in the viewer is main, store, exporters, sandbox
// and ~80 more) with SWC in `generateBundle`. Unpatched, it replaced the code
// and left the bundler's map alone, and the bundler had already emitted that
// map as a `.map` asset — so every rewritten chunk shipped with a map of the
// pre-rewrite (one-line, minified) code. PostHog then resolved ~10% of
// production frames: the ones that happened to land in an untouched chunk.
// patches/vite-plugin-top-level-await@1.6.0.patch chains SWC's own map onto
// the bundler's and rewrites the emitted asset. This drives the REAL patched
// plugin through a REAL vite build and checks a frame resolves.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const viewerRequire = createRequire(new URL('../apps/viewer/package.json', import.meta.url));
const { build } = await import(pathToFileURL(viewerRequire.resolve('vite')).href);
const topLevelAwait = viewerRequire('vite-plugin-top-level-await');

// Minimal source-map v3 decoder: returns, per generated line, the decoded
// segments [genCol, sourceIdx, origLine, origCol] with absolute values.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeMappings(mappings) {
  const lines = [];
  let src = 0, oLine = 0, oCol = 0;
  for (const line of mappings.split(';')) {
    const segs = [];
    let gCol = 0;
    for (const seg of line ? line.split(',') : []) {
      const vals = [];
      let value = 0, shift = 0;
      for (const ch of seg) {
        const digit = B64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) { shift += 5; continue; }
        vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0; shift = 0;
      }
      gCol += vals[0];
      if (vals.length >= 4) {
        src += vals[1]; oLine += vals[2]; oCol += vals[3];
        segs.push([gCol, src, oLine, oCol]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

// Where the map sends (line, column) of the emitted code: the closest segment
// at or before the column on that line, as a frame symbolicator does.
function originalFor(map, decoded, line, column) {
  const segs = decoded[line] ?? [];
  let hit = null;
  for (const seg of segs) if (seg[0] <= column) hit = seg;
  if (!hit) return null;
  const content = map.sourcesContent?.[hit[1]] ?? '';
  return { source: map.sources[hit[1]], text: content.split('\n')[hit[2]]?.slice(hit[3]) ?? '' };
}

async function buildFixture({ sourcemap }) {
  const dir = mkdtempSync(join(tmpdir(), 'ifc-lite-tla-maps-'));
  // A real top-level await (wraps the chunk) plus a dynamic import (wraps its
  // importer too), with enough distinct lines in the SOURCE that a frame can
  // only resolve to the right original line through a correctly chained map.
  // The build uses Vite's default minifier, so the plugin's re-print is
  // minified too (see the configResolved hunk in the patch); a stale map of
  // the bundler's pre-rewrite output would not line up with it.
  writeFileSync(join(dir, 'tla.js'), [
    'export const ready = await Promise.resolve(1);',
    'export function explode(reason) {',
    '  if (reason === "never") return 0;',
    '  throw new Error("tla-sourcemap-marker " + reason);',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'lazy.js'), 'export const lazy = () => "lazy";\n');
  // A second entry sharing tla.js puts it in a chunk of its own. That chunk
  // has no dynamic import, so Vite's import analysis never rewrites it after
  // the plugin: only the plugin's own update to the emitted .map asset can
  // make its map right (in the entry chunk Vite's rewrite would mask that).
  writeFileSync(join(dir, 'other.js'), 'import { explode } from "./tla.js";\nexport const other = () => explode("other");\n');
  writeFileSync(join(dir, 'entry.js'), [
    'import { explode, ready } from "./tla.js";',
    'export function run() {',
    '  console.log("tla-entry-marker");',
    '  return import("./lazy.js").then((m) => (ready ? explode(m.lazy()) : 0));',
    '}',
    '',
  ].join('\n'));
  await build({
    configFile: false,
    logLevel: 'silent',
    root: dir,
    plugins: [topLevelAwait()],
    build: {
      outDir: join(dir, 'dist'),
      target: 'esnext',
      sourcemap,
      rollupOptions: { input: { entry: join(dir, 'entry.js'), other: join(dir, 'other.js') }, preserveEntrySignatures: 'exports-only' },
    },
  });
  return dir;
}

// These tests read BUILD OUTPUT, never a source file: the chunks and maps the
// real plugin emitted for a fixture written above. Every text predicate on
// `code` below is therefore a check of produced artefacts (is this chunk one
// the plugin wrapped, where is the frame), which is why each carries a
// marker (see scripts/check-source-text-assertions.mjs) rather than an allowlist row.
function emitted(dir) {
  const assets = join(dir, 'dist', 'assets');
  return readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => {
    const file = join(assets, f);
    const mapFile = `${file}.map`;
    const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf8')) : null;
    const code = readFileSync(file, 'utf8');
    // @source-text-assertion-ok predicate on emitted build output, not source
    const wrapped = code.includes('__tla');
    // @source-text-assertion-ok predicate on emitted build output, not source
    const dynamicImport = code.includes('import(');
    return { name: f, code, map, wrapped, dynamicImport };
  });
}

// Resolve the first occurrence of `token` in an emitted chunk through the map
// that shipped with it, as a frame symbolicator would.
function resolveFrame(chunk, token) {
  const codeLines = chunk.code.split('\n');
  // @source-text-assertion-ok locating a frame in emitted build output
  const line = codeLines.findIndex((l) => l.includes(token));
  assert.ok(line >= 0, `${chunk.name} has no ${token}`);
  // @source-text-assertion-ok locating a frame in emitted build output
  const column = codeLines[line].indexOf(token);
  return originalFor(chunk.map, decodeMappings(chunk.map.mappings), line, column);
}

// @source-text-assertion-ok selects an emitted chunk by a marker it contains
const chunkWith = (chunks, needle) => chunks.find((c) => c.code.includes(needle));

test('a frame inside a TLA-rewritten chunk that Vite never touches again resolves', async () => {
  // Pins the patch's rewrite of the emitted `.map` ASSET: for this chunk
  // nothing after the plugin rewrites the asset, so without that hunk the
  // stale pre-rewrite map is what ships.
  const dir = await buildFixture({ sourcemap: true });
  try {
    const chunks = emitted(dir);
    const thrower = chunkWith(chunks, 'tla-sourcemap-marker');
    assert.ok(thrower, 'the throwing function must be in an emitted chunk');
    assert.ok(thrower.wrapped, 'the throwing chunk must be one the plugin rewrote');
    assert.ok(!thrower.dynamicImport, 'the throwing chunk must be one Vite does not rewrite again afterwards');
    assert.ok(thrower.map, `${thrower.name} must ship a .map`);

    const original = resolveFrame(thrower, 'throw');
    assert.ok(original, 'no mapping for the throw');
    assert.equal(original.source.split('/').pop(), 'tla.js');
    assert.equal(original.text.slice(0, 41), 'throw new Error("tla-sourcemap-marker " +');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a frame inside a TLA-rewritten chunk that Vite rewrites afterwards resolves', async () => {
  // Pins the patch's `chunk.map = map`: Vite's import analysis rewrites the
  // entry chunk (its dynamic import) AFTER the plugin and composes onto
  // chunk.map, so it must be handed the plugin's map, not the stale one.
  const dir = await buildFixture({ sourcemap: true });
  try {
    const chunks = emitted(dir);
    const entry = chunkWith(chunks, 'tla-entry-marker');
    assert.ok(entry, 'the entry chunk must be emitted');
    assert.ok(entry.wrapped, 'the entry chunk must be one the plugin rewrote');
    assert.ok(entry.dynamicImport, 'the entry chunk must be one Vite rewrites again afterwards');
    assert.ok(entry.map, `${entry.name} must ship a .map`);

    // `explode` is mangled in the output; the console.log call is not.
    const original = resolveFrame(entry, 'console.log');
    assert.ok(original, 'no mapping for the console.log call');
    assert.equal(original.source.split('/').pop(), 'entry.js');
    assert.equal(original.text, 'console.log("tla-entry-marker");');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without source maps the plugin still rewrites and emits no map', async () => {
  const dir = await buildFixture({ sourcemap: false });
  try {
    const chunks = emitted(dir);
    assert.ok(chunks.some((c) => c.wrapped));
    assert.ok(chunks.every((c) => c.map === null), 'no .map may be emitted when maps are off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
