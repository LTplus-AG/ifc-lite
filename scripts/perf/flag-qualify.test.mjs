/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import {
  FLAG_PRESETS, compareArms, failingTests, flagBootScript, flagSetLabel, injectBootScript, failingTestFiles,
  markdownTable, noRegression, testPatternFor, overall, parseFlagSet, registryFlagSpec, resolveModels,
  suiteRows, unitInjectable, unitPreloadSource, withNodeImport, writeFlaggedDist,
} from './flag-qualify-lib.mjs';
import { decodePng, encodePng, pixelStats } from './flag-qualify-pixels.mjs';

const image = (width, height, fill = [10, 20, 30, 255]) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
};

/** The registry shape `apps/viewer/src/lib/perf/flags.ts` uses: inline bindings, or a spread without them. */
const REGISTRY = `
  { id: 'batchSizing', kind: 'kill-switch', bindings: { ...GEOMETRY_PERF_FLAG_BINDINGS.batchSizing, benchmarkEnv: 'X' } },
  { id: 'drawStream', kind: 'ramp', owner: '@x', removalCondition: 'r', introducedAt: '2026-11-23', default: null,
    bindings: { global: '__IFC_LITE_M6__', urlParam: 'm6.stream' } },
  { id: 'fastPath', kind: 'kill-switch', bindings: { urlParam: 'perf.fastPath' } },`;
const drawStream = () => parseFlagSet('drawStream', REGISTRY);

describe('parseFlagSet', () => {
  it('forces a registry flag on through its own bindings', () => {
    assert.deepEqual(drawStream(), { name: 'drawStream', params: { 'm6.stream': '1' }, globals: { __IFC_LITE_M6__: 1 } });
    assert.equal(registryFlagSpec('fastPath', REGISTRY), 'perf.fastPath=1');
    assert.equal(registryFlagSpec('batchSizing', REGISTRY), null, 'spread bindings are not resolved');
    assert.throws(() => parseFlagSet('batchSizing', REGISTRY), /unknown flag/);
    assert.throws(() => parseFlagSet('nope', REGISTRY), /unknown flag/);
    assert.equal(registryFlagSpec('noBindings', `{ id: 'noBindings', kind: 'ramp' },${REGISTRY}`), null, 'never borrows the next entry');
  });

  it('expands a preset', () => {
    assert.ok(Object.keys(FLAG_PRESETS).every((name) => parseFlagSet(name).name === name));
    assert.deepEqual(parseFlagSet('drawStream-full').globals, { __IFC_LITE_M6__: { stream: 1, arena: 1, hlod: 1 } });
  });

  it('splits URL params from __IFC_LITE_* globals and keeps commas inside a JSON value', () => {
    const set = parseFlagSet('m6.stream=1,__IFC_LITE_M6__={"stream":1,"arena":1},perf.huge=1');
    assert.deepEqual(set.params, { 'm6.stream': '1', 'perf.huge': '1' });
    assert.deepEqual(set.globals, { __IFC_LITE_M6__: { stream: 1, arena: 1 } });
  });

  it('keeps a non-JSON global value as a string', () => {
    assert.deepEqual(parseFlagSet('__IFC_LITE_MODE=fast').globals, { __IFC_LITE_MODE: 'fast' });
  });

  it('refuses empty sets, entries without a value and bad names', () => {
    assert.throws(() => parseFlagSet(''), /empty/);
    assert.throws(() => parseFlagSet('m6.stream'), /name=value/);
    assert.throws(() => parseFlagSet('m6.stream='), /name=value/);
    assert.throws(() => parseFlagSet('__ifc_lite_x=1,9bad=1'), /bad flag/);
  });

  it('labels a set for file names', () => {
    assert.equal(flagSetLabel(parseFlagSet('m6.stream=1,m6.arena=1')), 'm6.stream_1_m6.arena_1');
    assert.equal(flagSetLabel(drawStream()), 'drawStream');
  });
});

describe('flagBootScript', () => {
  const boot = (href, flagSet) => {
    const replaced = [];
    const sandbox = { URL, location: { href }, history: { state: { k: 1 }, replaceState: (state, _t, url) => replaced.push([state, String(url)]) } };
    sandbox.globalThis = sandbox;
    runInNewContext(flagBootScript(flagSet), sandbox);
    return { sandbox, replaced };
  };

  it('sets the globals, merges the params into the URL and records what it forced', () => {
    const set = parseFlagSet('m6.stream=1,__IFC_LITE_M6__={"arena":1}');
    const { sandbox, replaced } = boot('http://x/?perfTrace=1#h', set);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__IFC_LITE_M6__)), { arena: 1 });
    assert.deepEqual(replaced, [[{ k: 1 }, 'http://x/?perfTrace=1&m6.stream=1#h']]);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__IFC_LITE_QUALIFY_FLAGS__)), { params: { 'm6.stream': '1' }, globals: { __IFC_LITE_M6__: { arena: 1 } } });
  });

  it('overrides a param the page already set and leaves a matching URL alone', () => {
    assert.deepEqual(boot('http://x/?m6.stream=0', parseFlagSet('m6.stream=1')).replaced.map(([, url]) => url), ['http://x/?m6.stream=1']);
    assert.deepEqual(boot('http://x/?m6.stream=1', parseFlagSet('m6.stream=1')).replaced, []);
  });

  it('cannot close its own script element', () => {
    assert.ok(!flagBootScript(parseFlagSet('__IFC_LITE_X="</script>"')).includes('</script>'));
  });
});

/** Run a page's inline scripts in document order in `sandbox`, as a browser would before its modules. */
function runPageScripts(markup, sandbox) {
  for (const [, body] of markup.matchAll(/<script(?: [^>]*)?>([^<]*)<\/script>/g)) if (body.trim()) runInNewContext(body, sandbox);
  return sandbox;
}

describe('flagged dist', () => {
  it('runs the boot script before every script the page already had', () => {
    const page = injectBootScript('<html><head lang="en"><script>order.push("app")</script></head></html>', 'order.push("boot")');
    assert.deepEqual([...runPageScripts(page, { order: [] }).order], ['boot', 'app']);
    assert.throws(() => injectBootScript('<html></html>', 'x'), /no <head>/);
  });

  it('links the build and writes only a patched index.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flag-qualify-'));
    try {
      mkdirSync(join(dir, 'dist/assets'), { recursive: true });
      writeFileSync(join(dir, 'dist/index.html'), '<head><script type="module" src="/assets/a.js"></script></head>');
      writeFileSync(join(dir, 'dist/assets/a.js'), 'x');
      writeFlaggedDist(join(dir, 'dist'), join(dir, 'on'), drawStream());
      assert.ok(lstatSync(join(dir, 'on/assets')).isSymbolicLink(), 'the build is linked, not copied');
      // Behaviour, not text: run the scripts the flagged page runs before its app, in page order.
      const page = { URL, location: { href: 'http://x/' }, history: { state: null, replaceState: (_s, _t, url) => { page.location.href = String(url); } } };
      page.globalThis = page;
      runPageScripts(readFileSync(join(dir, 'on/index.html'), 'utf8'), page);
      assert.equal(page.__IFC_LITE_M6__, 1);
      assert.equal(new URL(page.location.href).searchParams.get('m6.stream'), '1');
      assert.equal(readFileSync(join(dir, 'on/assets/a.js'), 'utf8'), 'x');
      assert.equal(JSON.parse(readFileSync(join(dir, 'on/qualify-flags.json'), 'utf8')).name, 'drawStream');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('unit-suite injection', () => {
  it('preloads globals only, and says when a set has none', () => {
    const set = parseFlagSet('m6.stream=1,__IFC_LITE_M6__={"stream":1}');
    const sandbox = {};
    sandbox.globalThis = sandbox;
    runInNewContext(unitPreloadSource(set), sandbox);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__IFC_LITE_M6__)), { stream: 1 });
    assert.equal(unitInjectable(set), true);
    assert.equal(unitInjectable(parseFlagSet('m6.stream=1')), false);
    assert.equal(unitInjectable(drawStream()), true);
    assert.equal(withNodeImport('--max-old-space-size=4096', '/p.mjs'), '--max-old-space-size=4096 --import=/p.mjs');
    assert.equal(withNodeImport(undefined, '/p.mjs'), '--import=/p.mjs');
  });
});

describe('pixels', () => {
  it('round-trips a PNG', () => {
    const img = image(5, 3);
    img.data.set([255, 0, 7, 128], 4 * 7);
    assert.deepEqual(decodePng(encodePng(img)), img);
  });

  it('counts pixels over the threshold and tells isolated noise from regions', () => {
    const a = image(4, 4), b = image(4, 4);
    b.data.set([10 + 9, 20, 30, 255], 0); // isolated corner, 9 > 8
    for (const p of [10, 11, 14, 15]) b.data.set([10, 20 + 50, 30, 255], p * 4); // a 2x2 region
    b.data.set([10, 20, 30 + 8, 255], 5 * 4); // at the threshold: differs, not over
    const stats = pixelStats(a.data, b.data, 4, 4);
    assert.deepEqual(stats, { pixels: 16, differing: 6, over: 5, overPct: 31.25, isolatedPct: 20, max: 50 });
    assert.equal(pixelStats(a.data, a.data, 4, 4).over, 0);
    assert.throws(() => pixelStats(a.data, image(2, 2).data, 4, 4), /size/);
  });

  it('decodes every PNG row filter', () => {
    // A hand-built 1x4 RGB PNG, one row per filter: Sub, Up, Average, Paeth.
    const raw = Buffer.from([1, 10, 20, 30, 2, 1, 1, 1, 3, 2, 2, 2, 4, 3, 3, 3]);
    assert.deepEqual([...decodePng(rawPng(1, 4, 2, raw)).data], [10, 20, 30, 255, 11, 21, 31, 255, 7, 12, 17, 255, 10, 15, 20, 255]);
  });
});

function rawPng(width, height, colorType, raw) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes) => { let c = 0xffffffff; for (const x of bytes) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => { const l = Buffer.alloc(4); l.writeUInt32BE(body.length); const t = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([l, t, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('compareArms', () => {
  const files = new Map();
  const frame = (name, img) => { files.set(name, encodePng(img)); return { path: name, idle: true, stable: true }; };
  const arm = (arm, overrides = {}) => ({ arm, model: 'm', forced: arm === 'on' ? { params: { 'm6.stream': '1' } } : null,
    load: { ok: true, wallMs: 1000, firstFrameMs: 400, interactiveMs: 900 }, memory: { gpuBytes: 100 * 2 ** 20, jsHeapMiB: 200 },
    steps: {}, errors: [], ...overrides });
  const options = { readFile: (p) => files.get(p), writeDiff: (name) => `diff/${name}.png` };
  const verdicts = (rows) => Object.fromEntries(rows.map((r) => [r.check, r.verdict]));

  it('passes identical arms and fails a pixel difference with a diff image', () => {
    const changed = image(10, 10);
    for (let p = 0; p < 10; p++) changed.data.set([200, 0, 0, 255], p * 4);
    const off = arm('off', { steps: { home: { ok: true, area: 'render', frame: frame('off-home', image(10, 10)) }, pick: { ok: true, area: 'pick', facts: { picked: [1] }, frame: frame('off-pick', image(10, 10)) } } });
    const on = arm('on', { steps: { home: { ok: true, area: 'render', frame: frame('on-home', image(10, 10)) }, pick: { ok: true, area: 'pick', facts: { picked: [1] }, frame: frame('on-pick', changed) } } });
    const rows = compareArms(off, on, options);
    const v = verdicts(rows);
    assert.equal(v.loads, 'pass');
    assert.equal(v['flag forced on'], 'pass');
    assert.equal(v['home pixels'], 'pass');
    assert.equal(v['pick result'], 'pass');
    assert.equal(v['pick pixels'], 'fail');
    assert.equal(rows.find((r) => r.check === 'pick pixels').evidence, 'diff/m-pick.png');
    assert.equal(overall(rows), 'fail');
  });

  it('calls a step inconclusive where main is not deterministic, unless the flag is far worse', () => {
    const shade = (rows) => { const img = image(10, 10); for (let p = 0; p < rows * 10; p++) img.data.set([200, 0, 0, 255], p * 4); return img; };
    const off = arm('off', { steps: { home: { ok: true, frame: frame('n-off', image(10, 10)) } } });
    const on = (rows) => arm('on', { steps: { home: { ok: true, frame: frame(`n-on-${rows}`, shade(rows)) } } });
    assert.equal(verdicts(compareArms(off, on(1), options))['home pixels'], 'fail');
    const noise = arm('off2', { steps: { home: { ok: true, frame: frame('n-off2', shade(1)) } } });
    const row = compareArms(off, on(1), { ...options, noise }).find((r) => r.check === 'home pixels');
    assert.equal(row.verdict, 'skip');
    assert.match(row.detail, /^inconclusive.*main vs main 10%/);
    assert.equal(verdicts(compareArms(off, on(3), { ...options, noise }))['home pixels'], 'fail', '30% > 2 x 10% + 0.1%');
  });

  it("skips what flags-off fails too, and fails what only flags-on fails", () => {
    const off = arm('off', { steps: { export: { ok: false, error: 'no button' }, section: { ok: true, facts: null } } });
    const on = arm('on', { steps: { export: { ok: false, error: 'no button' }, section: { ok: false, error: 'boom' } } });
    const v = verdicts(compareArms(off, on, options));
    assert.equal(v.export, 'skip');
    assert.equal(v.section, 'fail');
  });

  it('fails different results and a load only flags-on loses, and flags a flag that never engaged', () => {
    const off = arm('off', { steps: { export: { ok: true, facts: { glbSha256: 'a' } } } });
    const on = arm('on', { forced: null, steps: { export: { ok: true, facts: { glbSha256: 'b' } } } });
    const v = verdicts(compareArms(off, on, options));
    assert.equal(v['export result'], 'fail');
    assert.equal(v['flag forced on'], 'fail');
    const lost = compareArms(arm('off'), arm('on', { load: { ok: false, failure: { kind: 'device-lost' } } }), options);
    assert.deepEqual(lost.map((r) => [r.check, r.verdict]), [['loads', 'fail']]);
    assert.equal(compareArms(arm('off', { load: { ok: false } }), arm('on', { load: { ok: false } }), options)[0].verdict, 'skip');
  });

  it('errors when an arm stopped after loading', () => {
    const off = arm('off', { steps: { home: { ok: true } } });
    const v = verdicts(compareArms(off, arm('on', { errors: ['scene never settled'] }), options));
    assert.equal(v['flags-on run completed'], 'error');
    assert.equal(v['home ran flags-on'], 'error');
  });

  it('checks load and memory regressions as diagnostics', () => {
    const rows = compareArms(arm('off'), arm('on', { load: { ok: true, firstFrameMs: 2000, interactiveMs: 950 }, memory: { gpuBytes: 300 * 2 ** 20, jsHeapMiB: 201 } }), { ...options, small: true });
    const v = verdicts(rows);
    assert.equal(v['first frame (diagnostic, n=1)'], 'fail');
    assert.equal(v['interactive (diagnostic, n=1)'], 'pass');
    assert.equal(v['GPU bytes (diagnostic, n=1)'], 'fail');
    assert.equal(v['JS heap (diagnostic, n=1)'], 'pass');
    assert.ok(rows.filter((r) => r.check.includes('diagnostic')).every((r) => r.area === 'small-model'));
    assert.equal(noRegression(100, 140, { ratio: 1.5 }), 'pass');
    assert.equal(noRegression(100, 400, { ratio: 1.5, slack: 500 }), 'pass');
    assert.equal(noRegression(null, 1), 'skip');
  });
});

describe('resolveModels', () => {
  const root = '/repo';
  it('expands groups, real models, synthetic tiers and explicit paths', () => {
    const models = resolveModels(['samples,real', 'campus-100k', 'pair=/a.ifc+/b.ifc'], { root, realDir: '/real',
      listDir: () => ['advanced_model.ifc', 'ISSUE_053_20181220Holter_Tower_10.ifc', 'tfs-500.ifc', 'notes.txt'] });
    assert.deepEqual(models.map((m) => m.name), ['hello-wall', 'building-architecture', 'infra-bridge', 'fzk', 'federation', 'holter', 'advanced-model', 'tfs', 'campus-100k', 'pair']);
    assert.equal(models.find((m) => m.name === 'federation').files.length, 2);
    assert.ok(models.find((m) => m.name === 'fzk').small);
    assert.equal(models.find((m) => m.name === 'tfs').files[0], '/real/tfs-500.ifc');
    assert.deepEqual(models.find((m) => m.name === 'campus-100k').synthetic, { scenario: 'mixed-campus', tier: '100k' });
    assert.deepEqual(models.find((m) => m.name === 'pair').files, ['/a.ifc', '/b.ifc']);
  });

  it('refuses unknown names and a missing real model', () => {
    assert.throws(() => resolveModels(['nope'], { root }), /unknown model/);
    assert.throws(() => resolveModels(['skolebygg'], { root, realDir: '/real', listDir: () => [] }), /not found/);
  });
});

describe('suite results', () => {
  it('reads failing tests from node:test and Playwright list output', () => {
    const text = ['✔ fine (1.2ms)', '✖ draw stream keeps picking (12.5ms)', '  ✖ nested case (3ms)', '✖ failing tests:',
      '  1) [viewer-e2e-ci] › tests/e2e/viewer-smoke.e2e.spec.ts:10:5 › loads a model', 'not ok 3 - tap case # time=1ms', 'ok 4 - fine'].join('\n');
    assert.deepEqual(failingTests(text), ['draw stream keeps picking', 'nested case', 'tap case', 'tests/e2e/viewer-smoke.e2e.spec.ts:10:5 › loads a model']);
  });

  it('names the failing test files and matches exactly those', () => {
    const text = 'test at src/utils/drawStreamConfig.test.ts:1:626\n  x\ntest at src/lib/perf/a+b.test.tsx:3:1\ntest at src/utils/drawStreamConfig.test.ts:9:1';
    const files = failingTestFiles(text);
    assert.deepEqual(files, ['src/lib/perf/a+b.test.tsx', 'src/utils/drawStreamConfig.test.ts']);
    const re = new RegExp(testPatternFor(files));
    assert.ok(re.test('src/lib/perf/a+b.test.tsx') && re.test('src/utils/drawStreamConfig.test.ts'));
    assert.ok(!re.test('src/utils/drawStreamConfigXtest.ts'), 'dots are literal');
  });

  it('blames the flag only for failures flags-off does not have', () => {
    const on = { exitCode: 1, failures: ['a', 'b'], log: 'on.log' };
    assert.deepEqual(suiteRows('unit', on, { exitCode: 1, failures: ['a'] }).map((r) => [r.check, r.verdict]), [['suite (flags on)', 'fail'], ['b', 'fail']]);
    assert.equal(suiteRows('unit', on, { exitCode: 1, failures: ['a', 'b'] })[0].verdict, 'pass');
    assert.equal(suiteRows('unit', { exitCode: 0, failures: [], log: '' }, null)[0].verdict, 'pass');
    assert.equal(suiteRows('unit', null, null)[0].verdict, 'skip');
    assert.equal(suiteRows('e2e', { exitCode: 1, failures: [], log: '' }, { exitCode: 1, failures: [] })[0].verdict, 'error', 'a run that never reached its tests');
  });

  it('renders one table with an overall verdict', () => {
    const md = markdownTable(drawStream(), [{ area: 'a|b', check: 'c', verdict: 'pass', detail: 'x', evidence: 'e' }, { area: 'z', check: 'y', verdict: 'skip' }]);
    assert.match(md, /^## Flag set `drawStream`: PASS/);
    assert.match(md, /\| a\\\|b \| c \| PASS \| x \| e \|/);
    assert.equal(overall([{ verdict: 'skip' }]), 'skip');
    assert.equal(overall([{ verdict: 'pass' }, { verdict: 'error' }]), 'fail');
  });
});
