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
  // importer too), with enough lines that a one-line minified map cannot
  // accidentally line up with the re-printed multi-line output.
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

function emitted(dir) {
  const assets = join(dir, 'dist', 'assets');
  return readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => {
    const file = join(assets, f);
    const mapFile = `${file}.map`;
    const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf8')) : null;
    return { name: f, code: readFileSync(file, 'utf8'), map };
  });
}

test('a frame inside a TLA-rewritten chunk resolves to its original source line', async () => {
  const dir = await buildFixture({ sourcemap: true });
  try {
    const chunks = emitted(dir);
    const wrapped = chunks.filter((c) => c.code.includes('__tla'));
    assert.ok(wrapped.length > 0, 'fixture must make the plugin rewrite at least one chunk, or this proves nothing');

    const thrower = chunks.find((c) => c.code.includes('tla-sourcemap-marker'));
    assert.ok(thrower, 'the throwing function must be in an emitted chunk');
    assert.ok(thrower.code.includes('__tla'), 'the throwing chunk must be one the plugin rewrote');
    assert.ok(!thrower.code.includes('import('), 'the throwing chunk must be one Vite does not rewrite again afterwards');
    assert.ok(thrower.map, `${thrower.name} must ship a .map`);

    // The plugin re-prints a one-line minified chunk across many lines, so a
    // map of the pre-rewrite code has no segments at all past its first lines.
    const codeLines = thrower.code.split('\n');
    const decoded = decodeMappings(thrower.map.mappings);
    const line = codeLines.findIndex((l) => l.includes('throw'));
    const column = codeLines[line].indexOf('throw');
    const original = originalFor(thrower.map, decoded, line, column);
    assert.ok(original, `no mapping for the throw at ${line + 1}:${column + 1}`);
    assert.match(original.source, /tla\.js$/);
    assert.match(original.text, /^throw new Error\("tla-sourcemap-marker "/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without source maps the plugin still rewrites and emits no map', async () => {
  const dir = await buildFixture({ sourcemap: false });
  try {
    const chunks = emitted(dir);
    assert.ok(chunks.some((c) => c.code.includes('__tla')));
    assert.ok(chunks.every((c) => c.map === null), 'no .map may be emitted when maps are off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
