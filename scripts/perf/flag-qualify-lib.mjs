/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure parts of the flag-on qualification command (`flag-qualify.mjs`, see
 * `flag-qualify.md`): flag-set parsing, the boot script that forces a flag set
 * on in a page, a built viewer patched to run that boot script before the app,
 * the Node preload for unit suites, pixel statistics and the pass/fail table.
 */

import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

/** Named flag sets beyond a single registry flag. */
export const FLAG_PRESETS = Object.freeze({
  'drawStream-full': 'm6.stream=1,m6.arena=1,m6.hlod=1,__IFC_LITE_M6__={"stream":1,"arena":1,"hlod":1}',
});

/**
 * A registry flag (`apps/viewer/src/lib/perf/flags.ts`) forced on: `1` on its
 * URL param and on its global, so the unit suite (no URL) sees it too. Read
 * from the registry's inline `bindings`, so a new or renamed flag needs no
 * edit here. `null` when `id` has no inline binding there.
 */
export function registryFlagSpec(id, registrySource) {
  // The scan stops at the next entry's `id:`, so an entry without inline bindings never borrows the next one's.
  const entry = new RegExp(`id: '${id.replace(/[^\w.-]/g, '')}',(?:(?!id: ')[\\s\\S])*?bindings: \\{([^}]*)\\}`).exec(registrySource);
  if (!entry) return null;
  const binding = (key) => new RegExp(`${key}: '([^']+)'`).exec(entry[1])?.[1];
  const parts = [binding('urlParam') && `${binding('urlParam')}=1`, binding('global') && `${binding('global')}=1`].filter(Boolean);
  return parts.length ? parts.join(',') : null;
}

const GLOBAL_NAME = /^__IFC_LITE_[A-Z0-9_]+$/;
const PARAM_NAME = /^[A-Za-z][\w.-]*$/;

function parseGlobalValue(raw) {
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * `"m6.stream=1,__IFC_LITE_M6__={\"arena\":1}"` (or a preset or registry flag id) ->
 * `{ name, params: { 'm6.stream': '1' }, globals: { __IFC_LITE_M6__: { arena: 1 } } }`.
 * A `__IFC_LITE_*` name is a page global (its value parsed as JSON when it
 * parses); any other name is a URL query param. Commas inside a JSON value
 * are kept: an entry ends at the next `,name=`.
 */
export function parseFlagSet(spec, registrySource = '') {
  const text = String(spec ?? '').trim();
  if (!text) throw new Error('empty flag set');
  const named = FLAG_PRESETS[text] ?? (/^[A-Za-z]\w*$/.test(text) ? registryFlagSpec(text, registrySource) : null);
  if (!named && /^[A-Za-z]\w*$/.test(text)) throw new Error(`unknown flag "${text}": not a preset or an inline-bound registry flag`);
  const expanded = named ?? text;
  const params = {}, globals = {};
  for (const entry of expanded.split(/,(?=\s*[A-Za-z_][\w.-]*=)/)) {
    const at = entry.indexOf('=');
    const name = entry.slice(0, at).trim(), value = entry.slice(at + 1).trim();
    if (at <= 0 || value === '') throw new Error(`bad flag entry "${entry}": expected name=value`);
    if (GLOBAL_NAME.test(name)) globals[name] = parseGlobalValue(value);
    else if (PARAM_NAME.test(name)) params[name] = value;
    else throw new Error(`bad flag name "${name}": a URL param or a __IFC_LITE_* global`);
  }
  return { name: named ? text : expanded, params, globals };
}

/** File-name-safe label of a flag set. */
export function flagSetLabel(flagSet) {
  return flagSet.name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'flags';
}

/**
 * Self-contained page script that forces `flagSet` on before the viewer boots:
 * sets the globals and merges the params into the URL (history.replaceState,
 * no navigation), so every binding the registry reads sees the flag. Records
 * what it forced on `__IFC_LITE_QUALIFY_FLAGS__` for the evidence.
 */
export function flagBootScript(flagSet) {
  const payload = JSON.stringify({ params: flagSet.params, globals: flagSet.globals }).replace(/</g, '\\u003c');
  return `(() => {
  const forced = ${payload};
  for (const [name, value] of Object.entries(forced.globals)) globalThis[name] = value;
  const url = new URL(location.href);
  let changed = false;
  for (const [name, value] of Object.entries(forced.params)) {
    if (url.searchParams.get(name) !== value) { url.searchParams.set(name, value); changed = true; }
  }
  if (changed) history.replaceState(history.state, '', url);
  globalThis.__IFC_LITE_QUALIFY_FLAGS__ = forced;
})();`;
}

/** `html` with `script` as the first element of `<head>`, before any module script. */
export function injectBootScript(html, script) {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) throw new Error('index.html has no <head>');
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}\n<script data-ifc-lite-qualify>${script}</script>${html.slice(at)}`;
}

/**
 * A built viewer at `out` with `flagSet` forced on: links to every entry of
 * `dist` except `index.html`, which is written patched (no copy of the build).
 */
export function writeFlaggedDist(dist, out, flagSet) {
  mkdirSync(out, { recursive: true });
  for (const entry of readdirSync(dist)) if (entry !== 'index.html') symlinkSync(join(dist, entry), join(out, entry));
  writeFileSync(join(out, 'index.html'), injectBootScript(readFileSync(join(dist, 'index.html'), 'utf8'), flagBootScript(flagSet)));
  writeFileSync(join(out, 'qualify-flags.json'), `${JSON.stringify(flagSet, null, 2)}\n`);
  return out;
}

/**
 * Node `--import` preload for a unit suite: the globals only. A unit test has
 * no URL, so a param-only flag cannot be forced there (`unitInjectable`).
 */
export function unitPreloadSource(flagSet) {
  return Object.entries(flagSet.globals).map(([name, value]) => `globalThis[${JSON.stringify(name)}] = ${JSON.stringify(value)};`).join('\n') + '\n';
}

export function unitInjectable(flagSet) {
  return Object.keys(flagSet.globals).length > 0;
}

/** NODE_OPTIONS with `--import=<preload>` appended. */
export function withNodeImport(nodeOptions, preload) {
  return [nodeOptions ?? '', `--import=${preload}`].filter(Boolean).join(' ').trim();
}

/**
 * Per-pixel comparison of two RGBA buffers of one size. `threshold` is the
 * largest channel difference still counted as equal (8/255 by default, the
 * campaign's method). Isolated pixels (no differing 4-neighbour) are counted
 * apart: depth-tie noise is isolated, a real difference forms regions.
 */
export function pixelStats(a, b, width, height, { threshold = 8 } = {}) {
  if (a.length !== b.length || a.length !== width * height * 4) throw new Error('pixel buffers differ in size');
  const over = new Uint8Array(width * height);
  let differing = 0, count = 0, max = 0;
  for (let i = 0, p = 0; p < over.length; i += 4, p++) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d) differing++;
    if (d > max) max = d;
    if (d > threshold) { over[p] = 1; count++; }
  }
  let isolated = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (!over[p]) continue;
    const near = (x > 0 && over[p - 1]) || (x < width - 1 && over[p + 1]) || (y > 0 && over[p - width]) || (y < height - 1 && over[p + width]);
    if (!near) isolated++;
  }
  const pixels = width * height;
  return { pixels, differing, over: count, overPct: +(100 * count / pixels).toFixed(4), isolatedPct: count ? +(100 * isolated / count).toFixed(1) : 0, max };
}


/**
 * Diagnostic no-regression check of one metric (single untimed sample per
 * arm): fails only when `on` exceeds `off` by more than `ratio` AND `slack`.
 */
export function noRegression(off, on, { ratio = 1.5, slack = 0 } = {}) {
  if (!Number.isFinite(off) || !Number.isFinite(on)) return 'skip';
  return on <= off * ratio || on - off <= slack ? 'pass' : 'fail';
}

const ICON = { pass: 'PASS', fail: 'FAIL', skip: 'skip', error: 'ERROR' };

/** Overall verdict of a list of checks: any fail/error fails; all skipped skips. */
export function overall(rows) {
  if (rows.some((r) => r.verdict === 'fail' || r.verdict === 'error')) return 'fail';
  if (rows.length === 0 || rows.every((r) => r.verdict === 'skip')) return 'skip';
  return 'pass';
}

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** One markdown pass/fail table: rows of `{ area, check, verdict, detail, evidence }`. */
export function markdownTable(flagSet, rows, { title } = {}) {
  const lines = [`## ${cell(title ?? `Flag set \`${flagSet.name}\``)}: ${ICON[overall(rows)]}`, '',
    '| area | check | verdict | detail | evidence |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${cell(r.area)} | ${cell(r.check)} | ${ICON[r.verdict] ?? cell(r.verdict)} | ${cell(r.detail)} | ${cell(r.evidence)} |`);
  return `${lines.join('\n')}\n`;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG (what a canvas encodes) to RGBA. */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let width = 0, height = 0, channels = 0;
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[data[9]] ?? 0;
      if (data[8] !== 8 || !channels || data[12] !== 0) throw new Error('unsupported PNG (need 8-bit RGB/RGBA, not interlaced)');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride), line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0, up = prev[x], corner = x >= channels ? prev[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      line[x] = (src[x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) rgba[o + c] = line[x * channels + c];
      rgba[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    [prev, line] = [line, prev];
  }
  return { width, height, data: rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Encode RGBA as an 8-bit PNG (filter 0): the diff images. */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type, body) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([head, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** `a` dimmed with every pixel over the threshold in red: where two frames differ. */
export function diffImage(a, b, { threshold = 8 } = {}) {
  const data = new Uint8Array(a.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > threshold) { data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; }
    else for (let c = 0; c < 3; c++) data[i + c] = a.data[i + c] * 0.35;
    data[i + 3] = 255;
  }
  return { width: a.width, height: a.height, data };
}

/** Pixel statistics of two PNG files' bytes; `null` stats when the sizes differ. */
export function comparePngs(aBytes, bBytes, options) {
  return compareImages(decodePng(aBytes), decodePng(bBytes), options);
}

function compareImages(a, b, options) {
  if (a.width !== b.width || a.height !== b.height) return { a, b, stats: null, sizeMismatch: [a.width, a.height, b.width, b.height] };
  return { a, b, stats: pixelStats(a.data, b.data, a.width, a.height, options) };
}

const sameFacts = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const mib = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 2 ** 20).toFixed(1)} MiB` : 'n/a');
const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : 'n/a');

/**
 * Pass/fail rows for one model: the flags-on arm against the flags-off arm of
 * the same build. A check the flags-off arm also fails is a main defect, not
 * the flag's: it is skipped with the reason. `readFile(path)` reads a frame;
 * `writeDiff(name, pngBytes)` stores a diff image and returns its path.
 * `noise` is a second flags-off arm. A step where main differs from itself by
 * more than `pixelMaxPct` is inconclusive (`skip`), unless the flag differs by
 * more than twice that plus the gate.
 */
export function compareArms(off, on, { pixelMaxPct = 0.1, threshold = 8, readFile, writeDiff, small = false, noise = null } = {}) {
  const rows = [];
  const decoded = new Map();
  const image = (path) => { if (!decoded.has(path)) decoded.set(path, decodePng(readFile(path))); return decoded.get(path); };
  const add = (area, check, verdict, detail, evidence = '') => rows.push({ area, check, verdict, detail, evidence, model: on.model });
  const loadDetail = (r) => (r.load?.ok ? `ok ${ms(r.load.wallMs)}` : `failed: ${r.load?.failure?.kind ?? r.errors?.[0] ?? 'no load'}`);
  if (!on.load?.ok) {
    add('load', 'loads', off.load?.ok ? 'fail' : 'skip', `on ${loadDetail(on)}; off ${loadDetail(off)}`);
    return rows;
  }
  add('load', 'loads', 'pass', `on ${loadDetail(on)}; off ${loadDetail(off)}`);
  // An arm that threw after loading ran only part of the script: never let the missing steps pass.
  if (on.errors?.length) add('load', 'flags-on run completed', 'error', on.errors.join('; ').slice(0, 300));
  if (off.errors?.length) add('load', 'flags-off run completed', 'error', off.errors.join('; ').slice(0, 300));
  for (const id of Object.keys(off.steps ?? {})) if (!on.steps?.[id]) add('load', `${id} ran flags-on`, 'error', 'step missing from the flags-on run');
  add('load', 'flag forced on', on.forced ? 'pass' : 'fail', on.forced ? JSON.stringify(on.forced).slice(0, 160) : 'boot script did not run');
  if (!off.load?.ok) return rows;
  const diag = '(diagnostic, n=1)';
  const regress = (check, a, b, fmt, options) => add(small ? 'small-model' : 'load', `${check} ${diag}`, noRegression(a, b, options), `off ${fmt(a)} -> on ${fmt(b)}`);
  regress('first frame', off.load.firstFrameMs, on.load.firstFrameMs, ms, { ratio: 1.5, slack: 250 });
  regress('interactive', off.load.interactiveMs, on.load.interactiveMs, ms, { ratio: 1.5, slack: 500 });
  regress('GPU bytes', off.memory?.gpuBytes, on.memory?.gpuBytes, mib, { ratio: 1.1, slack: 8 * 2 ** 20 });
  regress('JS heap', off.memory?.jsHeapMiB, on.memory?.jsHeapMiB, (v) => (Number.isFinite(v) ? `${v.toFixed(1)} MiB` : 'n/a'), { ratio: 1.15, slack: 32 });
  for (const [id, b] of Object.entries(on.steps ?? {})) {
    const a = off.steps?.[id];
    const area = b.area ?? id;
    if (!a?.ok && !b.ok) { add(area, id, 'skip', `fails flags-off too: ${a?.error ?? 'not run'}`); continue; }
    if (!b.ok) { add(area, id, 'fail', `on: ${b.error}`); continue; }
    if (!a?.ok) { add(area, id, 'pass', `on ok; off failed: ${a?.error ?? 'not run'}`); continue; }
    if (!sameFacts(a.facts, b.facts)) { add(area, `${id} result`, 'fail', `off ${JSON.stringify(a.facts)} vs on ${JSON.stringify(b.facts)}`.slice(0, 400), b.evidence ?? ''); }
    else if (a.facts) add(area, `${id} result`, 'pass', JSON.stringify(b.facts).slice(0, 200), b.evidence ?? '');
    if (!a.frame || !b.frame) continue;
    const cmp = compareImages(image(a.frame.path), image(b.frame.path), { threshold });
    if (!cmp.stats) { add(area, `${id} pixels`, 'fail', `frame sizes differ ${cmp.sizeMismatch.join('x')}`, b.frame.path); continue; }
    const diff = cmp.stats.over ? writeDiff(`${on.model}-${id}`, encodePng(diffImage(cmp.a, cmp.b, { threshold }))) : '';
    const unstable = a.frame.stable && b.frame.stable ? '' : '; a readback was not stable';
    const again = noise?.steps?.[id]?.frame;
    const noisePct = again ? compareImages(image(a.frame.path), image(again.path), { threshold }).stats?.overPct ?? null : null;
    // Main differing from itself past the gate makes the step inconclusive, unless the flag
    // differs by clearly more than that (twice main's own difference plus the gate).
    const noisy = noisePct !== null && noisePct > pixelMaxPct;
    const verdict = !noisy ? (cmp.stats.overPct <= pixelMaxPct ? 'pass' : 'fail')
      : cmp.stats.overPct > 2 * noisePct + pixelMaxPct ? 'fail' : 'skip';
    add(area, `${id} pixels`, verdict,
      `${noisy && verdict === 'skip' ? 'inconclusive, main is not deterministic here: ' : ''}${cmp.stats.overPct}% > ${threshold}/255 (max ${cmp.stats.max}, ${cmp.stats.isolatedPct}% isolated; gate ${pixelMaxPct}%${noisePct === null ? '' : `, main vs main ${noisePct}%`})${unstable}`, diff || b.frame.path);
  }
  return rows;
}

/** In-tree models (committed, all small: the no-regression set) and the federation pair. */
export const IN_TREE_MODELS = Object.freeze({
  'hello-wall': ['apps/viewer/public/samples/hello-wall.ifc'],
  'building-architecture': ['apps/viewer/public/samples/building-architecture.ifc'],
  'infra-bridge': ['apps/viewer/public/samples/infra-bridge.ifc'],
  fzk: ['apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc'],
  federation: ['apps/viewer/public/samples/building-architecture.ifc', 'apps/viewer/public/samples/building-architecture-rev-b.ifc'],
});

/** Campaign real models, looked up by file name in `--real-dir` (never committed). */
export const REAL_MODELS = Object.freeze({
  holter: /^ISSUE_053_20181220Holter_Tower_10\.ifc$/,
  'advanced-model': /^advanced_model\.ifc$/,
  skolebygg: /^ISSUE_068_ARK_NUS_skolebygg\.ifc$/,
  tfs: /^tfs.*\.ifc$/i,
});

/**
 * Model selection -> `[{ name, files, small, synthetic? }]`. Each spec is a
 * group (`samples`, `real`), an in-tree or real model name, `campus-<tier>`
 * (synthetic mixed-campus, generated at run time), or `name=path[+path...]`.
 * `listDir(dir)` lists a directory (injectable for tests).
 */
export function resolveModels(specs, { root, realDir = null, listDir = () => [] } = {}) {
  const out = [];
  const realFiles = realDir ? listDir(realDir) : [];
  const inTree = (name) => ({ name, files: IN_TREE_MODELS[name].map((f) => join(root, f)), small: true });
  const real = (name) => {
    const file = realFiles.filter((f) => REAL_MODELS[name].test(f)).sort()[0];
    return file ? { name, files: [join(realDir, file)], small: false } : null;
  };
  for (const spec of specs.flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean)) {
    if (spec === 'samples') { out.push(...Object.keys(IN_TREE_MODELS).map((name) => inTree(name))); continue; }
    if (spec === 'real') { out.push(...Object.keys(REAL_MODELS).map(real).filter(Boolean)); continue; }
    if (IN_TREE_MODELS[spec]) { out.push(inTree(spec)); continue; }
    if (REAL_MODELS[spec]) {
      const model = real(spec);
      if (!model) throw new Error(`real model ${spec} not found in --real-dir ${realDir ?? '(unset)'}`);
      out.push(model);
      continue;
    }
    const campus = /^campus-(\d+(?:\.\d+)?[kKmM]?)$/.exec(spec);
    if (campus) { out.push({ name: spec, files: null, small: false, synthetic: { scenario: 'mixed-campus', tier: campus[1] } }); continue; }
    const explicit = /^([\w.-]+)=(.+)$/.exec(spec);
    if (explicit) { out.push({ name: explicit[1], files: explicit[2].split('+'), small: false }); continue; }
    throw new Error(`unknown model "${spec}": samples, real, ${Object.keys(IN_TREE_MODELS).join(', ')}, ${Object.keys(REAL_MODELS).join(', ')}, campus-<tier> or name=path[+path]`);
  }
  return out;
}

/** Failing test names in node:test spec or TAP output (TAP when piped on Node < 24) or Playwright list output. */
export function failingTests(text) {
  const names = new Set();
  for (const line of String(text).split('\n')) {
    const m = /^\s*✖\s+(.+?)(?:\s+\(\d[\d.]*m?s\))?\s*$/.exec(line) ?? /^\s*\d+\)\s+\[[\w-]+\]\s+›\s+(.+?)\s*$/.exec(line)
      ?? /^\s*not ok \d+ - (.+?)(?:\s+#.*)?\s*$/.exec(line);
    if (m && !/^failing tests:?$/i.test(m[1])) names.add(m[1]);
  }
  return [...names].sort();
}

/** Test files the node:test reporter names for its failures (`test at src/...test.ts:L:C`). */
export function failingTestFiles(text) {
  const files = new Set();
  for (const m of String(text).matchAll(/^test at (\S+?\.test\.[cm]?[jt]sx?):\d+/gm)) files.add(m[1]);
  return [...files].sort();
}

/** A viewer `TEST_PATTERN` (awk regex over file paths) matching exactly `files`. */
export function testPatternFor(files) {
  return files.map((f) => f.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&')).join('|');
}

/**
 * Rows for a suite run with the flags forced on, against the same suite
 * flags-off: a failure only the flags-on run has is the flag's.
 */
export function suiteRows(area, on, off) {
  if (!on) return [{ area, check: 'suite', verdict: 'skip', detail: 'not run', evidence: '' }];
  const offFails = new Set(off?.failures ?? []);
  const added = on.failures.filter((name) => !offFails.has(name));
  // A failed run with no failing test named did not run its tests (setup, build or config).
  const verdict = on.exitCode === 0 ? 'pass' : on.failures.length === 0 ? 'error' : added.length || !off ? 'fail' : 'pass';
  const rows = [{ area, check: 'suite (flags on)', verdict,
    detail: `exit ${on.exitCode}; ${on.failures.length} failing${off ? `, ${added.length} only with the flags on (flags-off exit ${off.exitCode}, ${offFails.size} failing)` : ''}`, evidence: on.log }];
  for (const name of added.slice(0, 40)) rows.push({ area, check: name, verdict: 'fail', detail: 'fails only with the flags on', evidence: on.log });
  return rows;
}
