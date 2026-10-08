// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6959: the `bundle` family measurer, and the committed ceiling files.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

rt('measureBundle gates raw JS bytes, reports JS brotli as informational, and brotli of the wasm round-trips', () => {
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
    const info = Object.fromEntries(out.informational.map((m) => [m.id, m]));
    assert.equal(v['viewer-entry-js-bytes'].value, entryJs.length);
    assert.equal(v['viewer-entry-js-bytes'].detail, 'index-AbC123.js');
    assert.equal(v['viewer-eager-js-bytes'].value, entryJs.length + 2 * 'export {}'.length);
    assert.match(v['viewer-eager-js-bytes'].detail, /^3 files;/);
    // #7007: JS brotli is reported, never gated.
    assert.equal(v['viewer-entry-js-brotli'], undefined);
    assert.equal(v['viewer-eager-js-brotli'], undefined);
    assert.equal(info['viewer-entry-js-brotli'].value, measure.brotliSize(Buffer.from(entryJs)));
    assert.ok(info['viewer-entry-js-brotli'].value < entryJs.length, 'repetitive JS compresses');
    assert.match(v['engine-wasm-brotli'].detail, /raw 4096 bytes/);
    // The number is a real brotli stream's length, not an estimate.
    const stream = brotliCompressSync(wasmBytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: wasmBytes.length } });
    assert.equal(v['engine-wasm-brotli'].value, stream.length);
    assert.deepEqual(brotliDecompressSync(stream), wasmBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #7002: a dist whose eager set and non-eager files are all distinguishable by size.
function jsOf(seed, n) {
  let x = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += String.fromCharCode(97 + (x % 26));
  }
  return out;
}
const EAGER_HTML = `<!DOCTYPE html><html><head>
  <script type="module" crossorigin src="/assets/index-entry.js"></script>
  <link rel="modulepreload" crossorigin href="/assets/vendor-a.js">
  <link rel=modulepreload href='/assets/vendor-b.mjs'>
  <link rel="modulepreload" href="/assets/vendor-a.js">
  <link rel="modulepreload" href="/assets/vendor-b.mjs?v=2">
  <link rel="modulepreload" href="/assets/vendor-c.js">
  <link rel="modulepreload" href="/assets/style-preloaded.css">
  <link rel="preload" as="font" href="/assets/font.woff2">
  <link rel="stylesheet" href="/assets/index.css">
</head><body></body></html>`;

rt('viewer-eager-js-bytes sums the raw size of each eager JS file, once, and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'perf-ratchet-eager-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), EAGER_HTML);
    const eagerFiles = { 'index-entry.js': jsOf(1, 3000), 'vendor-a.js': jsOf(2, 2000), 'vendor-b.mjs': jsOf(3, 1500), 'vendor-c.js': jsOf(4, 1000) };
    for (const [name, body] of Object.entries(eagerFiles)) writeFileSync(join(dist, 'assets', name), body);
    // Present in dist but never loaded eagerly: must add nothing.
    writeFileSync(join(dist, 'assets/lazy-chunk.js'), jsOf(5, 9000));
    writeFileSync(join(dist, 'assets/style-preloaded.css'), jsOf(6, 7000));
    writeFileSync(join(dist, 'assets/font.woff2'), jsOf(7, 7000));
    writeFileSync(join(dist, 'assets/index.css'), jsOf(8, 7000));
    const wasm = join(root, 'engine.wasm');
    writeFileSync(wasm, 'x');

    const out = measure.measureBundle({ wasm, dist, commit: 'abc1234', measuredAt: '2026-10-06T00:00:00.000Z' });
    assert.deepEqual(ceilings.validateMeasuredFile(out), []);
    const v = Object.fromEntries(out.metrics.map((m) => [m.id, m]));
    assert.ok(v['viewer-eager-js-bytes'], 'the eager-bytes metric is emitted');
    // 3000 + 2000 + 1500 + 1000: the lazy chunk (9000) and the non-JS preloads add nothing.
    assert.equal(v['viewer-eager-js-bytes'].value, 7500);
    assert.equal(v['viewer-eager-js-bytes'].detail, '4 files; index-entry.js vendor-a.js vendor-b.mjs vendor-c.js');
    const info = Object.fromEntries(out.informational.map((m) => [m.id, m]));
    const expected = Object.values(eagerFiles).reduce((n, body) => n + measure.brotliSize(Buffer.from(body)), 0);
    assert.equal(info['viewer-eager-js-brotli'].value, expected);
    assert.match(info['viewer-eager-js-brotli'].detail, /^4 files, each compressed on its own$/);
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
  // #7007: viewer JS is gated on raw bytes, which repeat exactly, at 0.1%;
  // the engine wasm stays on brotli at 0.5%.
  for (const id of ['viewer-entry-js-bytes', 'viewer-eager-js-bytes']) {
    const e = bundle.entries.find((x) => x.id === id);
    assert.deepEqual(e.tolerance, { kind: 'relative', value: 0.001 }, id);
    assert.equal(e.metric, 'raw-bytes', id);
  }
  const wasm = bundle.entries.find((e) => e.id === 'engine-wasm-brotli');
  assert.deepEqual(wasm.tolerance, { kind: 'relative', value: 0.005 });
  assert.equal(wasm.metric, 'brotli-bytes');
});

// #7002 review: shapes of index.html that must not change what counts as eager.
// Entered through measureBundle, the producer of the metrics list.
function inShape(files, html, body) {
  const root = mkdtempSync(join(tmpdir(), 'perf-ratchet-shapes-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    for (const f of files) writeFileSync(join(dist, 'assets', f), 'export {}');
    writeFileSync(join(dist, 'index.html'), html);
    writeFileSync(join(root, 'w.wasm'), 'x');
    return body(() => measure.measureBundle({ wasm: join(root, 'w.wasm'), dist, commit: 'a' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const metricsOf = (out) => Object.fromEntries(out.metrics.map((m) => [m.id, m]));

rt('markup that only appears inside an inline script body is not an eager load', () => {
  const html = `<script>var s = '<link rel="modulepreload" href="/assets/ghost.js"><script type="module" src="/assets/ghost2.js"><\\/script>';</script>
      <script type="module" src="/assets/entry.js"></script>
      <link rel="modulepreload" href="/assets/real.js">`;
  inShape(['entry.js', 'real.js'], html, (run) => {
    const v = metricsOf(run());
    assert.ok(v['viewer-eager-js-bytes'], 'the eager-bytes metric is emitted');
    assert.equal(v['viewer-eager-js-bytes'].detail, '2 files; entry.js real.js');
  });
});

rt('nomodule scripts and non-JavaScript script types are not eager', () => {
  const html = `<script type="module" src="/assets/entry.js"></script>
      <script nomodule src="/assets/legacy.js"></script>
      <script type="importmap" src="/assets/map.js"></script>`;
  inShape(['entry.js', 'legacy.js'], html, (run) => {
    const v = metricsOf(run());
    assert.ok(v['viewer-eager-js-bytes'], 'the eager-bytes metric is emitted');
    assert.equal(v['viewer-eager-js-bytes'].detail, '1 files; entry.js');
  });
});

rt('measureBundle throws on a preload that is not in dist and on an entry that is not JS', () => {
  inShape(['entry.js'], '<script type="module" src="/assets/entry.js"></script><link rel="modulepreload" href="/assets/gone.js">', (run) => {
    assert.throws(run, /is not in/);
  });
  // An unbuilt index.html (dev entry) would otherwise measure zero eager files.
  inShape(['entry.js'], '<script type="module" src="/src/main.tsx"></script>', (run) => {
    assert.throws(run, /no eager JS/);
  });
});

// #7007: the gate end to end, both CLIs spawned as child processes. Brotli of
// the viewer JS moves while raw bytes stay put (a same-length timestamp swap
// did exactly that in CI); only raw growth past 0.1% may fail the check.
const MEASURER = fileURLToPath(new URL('./measure-bundle.mjs', import.meta.url));
const CHECK_CLI = fileURLToPath(new URL('./perf-ratchet.mjs', import.meta.url));
rt('check ignores a brotli-only change of the viewer JS and fails on raw growth past 0.1%', () => {
  assert.ok(existsSync(MEASURER) && existsSync(CHECK_CLI), 'the perf-ratchet CLIs are absent');
  const root = mkdtempSync(join(tmpdir(), 'perf-ratchet-7007-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    mkdirSync(join(root, 'ceilings'));
    writeFileSync(join(dist, 'index.html'), '<script type="module" src="/assets/main.js"></script><link rel="modulepreload" href="/assets/dep.js">');
    writeFileSync(join(root, 'w.wasm'), Buffer.alloc(2048, 7));
    writeFileSync(join(dist, 'assets/dep.js'), jsOf(9, 5000));
    const stamp = (date) => writeFileSync(join(dist, 'assets/main.js'), `const BUILD_DATE = "${date}";\n${'export const x = 1;\n'.repeat(2000)}`);
    const measureTo = (name) => {
      const out = join(root, name);
      const r = spawnSync(process.execPath, [MEASURER, '--wasm', join(root, 'w.wasm'), '--dist', dist, '--out', out, '--commit', 'abc1234'], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(r.status, 0, r.stderr);
      return { out, data: JSON.parse(r.stdout) };
    };
    const check = (measured) => spawnSync(process.execPath, [CHECK_CLI, 'check', '--measured', measured, '--ceilings-dir', join(root, 'ceilings')], { encoding: 'utf8', timeout: 20_000 });

    stamp('2026-10-06T14:23:54.677Z');
    const first = measureTo('a.json').data;
    const prov = { commit: 'abc1234', measuredAt: '2026-10-06T00:00:00.000Z' };
    writeFileSync(join(root, 'ceilings/bundle.json'), JSON.stringify({
      family: 'bundle',
      entries: first.metrics.map((m) => ({
        id: m.id, metric: m.id.endsWith('-brotli') ? 'brotli-bytes' : 'raw-bytes', ceiling: m.value,
        tolerance: { kind: 'relative', value: m.id.endsWith('-brotli') ? 0.005 : 0.001 }, provenance: prov,
      })),
    }));
    let r = check(join(root, 'a.json'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Informational, not gated:/);
    assert.match(r.stdout, /`bundle\/viewer-entry-js-brotli`: [\d,]+ bytes \(main\.js\)/);

    // Same length, different bytes: brotli may move, raw does not, check passes.
    stamp('1999-01-01T00:00:00.000Z');
    const second = measureTo('b.json').data;
    assert.deepEqual(second.metrics.map((m) => m.value), first.metrics.map((m) => m.value));
    r = check(join(root, 'b.json'));
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // Raw growth just past 0.1% of the eager total fails, and names the metric.
    const eager = first.metrics.find((m) => m.id === 'viewer-eager-js-bytes').value;
    writeFileSync(join(dist, 'assets/dep.js'), jsOf(9, 5000 + Math.floor(eager * 0.001) + 1));
    r = check(measureTo('c.json').out);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /`bundle\/viewer-eager-js-bytes`.*FAIL: above ceiling \+ tolerance/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
