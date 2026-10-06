// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6959: the `bundle` family measurer, and the committed ceiling files.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import test from 'node:test';

async function load(rel) {
  const url = new URL(rel, import.meta.url);
  return existsSync(url) ? import(url.href) : null;
}
const measure = await load('./measure-bundle.mjs');
const ceilings = await load('./ceilings.mjs');
function rt(name, body) {
  test(name, () => {
    assert.ok(measure && ceilings, 'the perf-ratchet modules are absent');
    return body();
  });
}

// The shape Vite emits for apps/viewer: inline scripts, one module entry,
// modulepreloads for its static imports, a stylesheet that is not JS.
const VITE_HTML = `<!DOCTYPE html><html><head>
  <script>/* inline theme script, no src */</script>
  <!-- <script type="module" src="/assets/commented-out.js"></script> -->
  <script type="module" crossorigin src="/assets/index-AbC123.js"></script>
  <link rel="modulepreload" crossorigin href="/assets/vendor-react-1.js">
  <link rel=modulepreload href='/assets/vendor-zustand-2.js'>
  <link rel="modulepreload" href="/assets/vendor-react-1.js">
  <link rel="stylesheet" crossorigin href="/assets/index-x.css">
</head><body><div id="root"></div></body></html>`;

rt('eagerScripts finds the single module entry and de-duplicated preloads, ignoring comments', () => {
  const { entry, eager } = measure.eagerScripts(VITE_HTML);
  assert.equal(entry, '/assets/index-AbC123.js');
  assert.deepEqual(eager, ['/assets/index-AbC123.js', '/assets/vendor-react-1.js', '/assets/vendor-zustand-2.js']);
});

rt('eagerScripts refuses to guess when there is no entry or more than one', () => {
  assert.throws(() => measure.eagerScripts('<html><script src="/a.js"></script></html>'), /found 0/);
  assert.throws(() => measure.eagerScripts('<script type="module" src="/a.js"></script><script type="module" src="/b.js"></script>'), /found 2/);
});

rt('resolveAsset refuses paths outside dist and external URLs', () => {
  const dist = mkdtempSync(join(tmpdir(), 'perf-ratchet-dist-'));
  try {
    assert.throws(() => measure.resolveAsset(dist, '/../../etc/passwd'), /outside/);
    assert.throws(() => measure.resolveAsset(dist, 'https://cdn.example/x.js'), /not a local asset/);
    assert.throws(() => measure.resolveAsset(dist, '/assets/absent.js'), /is not in/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

rt('measureBundle reports brotli sizes that round-trip and counts eager JS only', () => {
  const root = mkdtempSync(join(tmpdir(), 'perf-ratchet-bundle-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), VITE_HTML);
    const entryJs = 'export const x = 1;\n'.repeat(500);
    writeFileSync(join(dist, 'assets/index-AbC123.js'), entryJs);
    writeFileSync(join(dist, 'assets/vendor-react-1.js'), 'export {}');
    writeFileSync(join(dist, 'assets/vendor-zustand-2.js'), 'export {}');
    const wasm = join(root, 'engine.wasm');
    const wasmBytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31) % 251));
    writeFileSync(wasm, wasmBytes);

    const out = measure.measureBundle({ wasm, dist, commit: 'abc1234', measuredAt: '2026-10-05T00:00:00.000Z' });
    assert.deepEqual(ceilings.validateMeasuredFile(out), []);
    const v = Object.fromEntries(out.metrics.map((m) => [m.id, m]));
    assert.equal(v['viewer-eager-js-chunks'].value, 3);
    assert.ok(v['viewer-entry-js-brotli'].value < entryJs.length, 'repetitive JS compresses');
    assert.match(v['viewer-entry-js-brotli'].detail, /^index-AbC123\.js, raw 10000 bytes$/);
    assert.match(v['engine-wasm-brotli'].detail, /raw 4096 bytes/);
    // The number is a real brotli stream's length, not an estimate.
    const stream = brotliCompressSync(wasmBytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: wasmBytes.length } });
    assert.equal(v['engine-wasm-brotli'].value, stream.length);
    assert.deepEqual(brotliDecompressSync(stream), wasmBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

rt('measureBundle names the missing build instead of measuring nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'perf-ratchet-empty-'));
  try {
    writeFileSync(join(root, 'w.wasm'), 'x');
    assert.throws(() => measure.measureBundle({ wasm: join(root, 'absent.wasm'), dist: root, commit: 'a' }), /engine wasm not found/);
    assert.throws(() => measure.measureBundle({ wasm: join(root, 'w.wasm'), dist: root, commit: 'a' }), /viewer build not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const CEILINGS_DIR = fileURLToPath(new URL('../../tests/perf-ratchets/', import.meta.url));

rt('every committed ceiling file is valid, and bundle.json ratchets exactly what the measurer emits', () => {
  const files = existsSync(CEILINGS_DIR) ? readdirSync(CEILINGS_DIR).filter((f) => f.endsWith('.json')) : [];
  assert.ok(files.includes('bundle.json'), 'tests/perf-ratchets/bundle.json is the first live family');
  for (const f of files) {
    const data = ceilings.loadCeilingFile(join(CEILINGS_DIR, f));
    assert.equal(`${data.family}.json`, f, `${f} declares family ${data.family}`);
  }
  // Same id set both ways: a metric the measurer stops emitting would read
  // `missing`, one it starts emitting `unratcheted` -- catch both here first.
  const bundle = ceilings.loadCeilingFile(join(CEILINGS_DIR, 'bundle.json'));
  const root = mkdtempSync(join(tmpdir(), 'perf-ratchet-ids-'));
  try {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<script type="module" src="/assets/i.js"></script>');
    writeFileSync(join(root, 'assets/i.js'), 'x');
    writeFileSync(join(root, 'w.wasm'), 'x');
    const ids = measure.measureBundle({ wasm: join(root, 'w.wasm'), dist: root, commit: 'a' }).metrics.map((m) => m.id).sort();
    assert.deepEqual(bundle.entries.map((e) => e.id).sort(), ids);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const chunks = bundle.entries.find((e) => e.id === 'viewer-eager-js-chunks');
  assert.equal(chunks.tolerance.kind, 'exact', 'a structural count has no tolerance band');
});
