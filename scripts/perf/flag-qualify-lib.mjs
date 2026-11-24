/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure parts of the flag-on qualification command (`flag-qualify.mjs`, see
 * `flag-qualify.md`): flag-set parsing, the boot script that forces a flag set
 * on in a page, a built viewer patched to run that boot script before the app,
 * the Node preload for unit suites, the arm comparison and the pass/fail
 * table. Pixels (PNG codec, statistics, diff image): `flag-qualify-pixels.mjs`.
 */

import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareImages, decodePng, diffImage, encodePng } from './flag-qualify-pixels.mjs';

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


const sameFacts = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const mib = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 2 ** 20).toFixed(1)} MiB` : 'n/a');
const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : 'n/a');

/**
 * Pass/fail rows for one model: the flags-on arm against the flags-off arm of
 * the same build. A check the flags-off arm also fails is a main defect, not
 * the flag's: it is skipped with the reason. `readFile(path)` reads a frame;
 * `writeDiff(name, pngBytes)` stores a diff image and returns its path.
 * `noise` holds more flags-off arms. Flags on passes a step when it matches any
 * flags-off load (main can render a step in more than one state between loads).
 * Otherwise a step where main differs from itself by more than `pixelMaxPct`
 * is inconclusive (`skip`), unless the flag differs by more than twice that
 * plus the gate.
 */
export function compareArms(off, on, { pixelMaxPct = 0.1, threshold = 8, readFile, writeDiff, small = false, noise = [] } = {}) {
  noise = [noise].flat().filter(Boolean); // gpu.json from before --noise-loads holds one arm
  const rows = [];
  const decoded = new Map();
  const image = (path) => { if (!decoded.has(path)) decoded.set(path, decodePng(readFile(path))); return decoded.get(path); };
  const add = (area, check, verdict, detail, evidence = '') => rows.push({ area, check, verdict, detail, evidence, model: on.model });
  const loadDetail = (r) => (r.load?.ok ? `ok ${ms(r.load.wallMs)}` : `failed: ${r.load?.failure?.kind ?? r.errors?.[0] ?? 'no load'}`);
  // An arm that threw (before or after loading) ran only part of the script: never let that pass or skip quietly.
  const armErrors = () => {
    if (on.errors?.length) add('load', 'flags-on run completed', 'error', on.errors.join('; ').slice(0, 300));
    if (off.errors?.length) add('load', 'flags-off run completed', 'error', off.errors.join('; ').slice(0, 300));
    noise.forEach((arm, i) => {
      if (arm.errors?.length || !arm.load?.ok) add('load', `flags-off load ${i + 2} completed`, 'error', (arm.errors?.join('; ') || 'did not load').slice(0, 300));
    });
  };
  if (!on.load?.ok) {
    add('load', 'loads', off.load?.ok ? 'fail' : 'skip', `on ${loadDetail(on)}; off ${loadDetail(off)}`);
    armErrors();
    return rows;
  }
  add('load', 'loads', 'pass', `on ${loadDetail(on)}; off ${loadDetail(off)}`);
  armErrors();
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
    // A capture that was not idle, or whose two readbacks differed, may be a transient frame: it cannot pass.
    const clean = (f) => f.idle !== false && f.stable;
    const settled = clean(a.frame) && clean(b.frame);
    const unstable = settled ? '' : '; a capture was not idle or its readbacks differed';
    // Main can render a step in more than one state between loads (a coplanar tie that the
    // load-order-dependent frame origin decides): flags on matching ANY flags-off load is one of
    // main's own states. Only a load whose run and step completed with a settled capture counts.
    const extra = noise.map((arm, i) => ({ arm, load: i + 2, f: arm.steps?.[id]?.frame }))
      .filter(({ arm, f }) => arm.load?.ok && !arm.errors?.length && arm.steps[id].ok && f && clean(f));
    // Main's own difference between loads; a size mismatch is as far apart as frames get.
    const noisePct = extra.length
      ? Math.max(...extra.map(({ f }) => compareImages(image(a.frame.path), image(f.path), { threshold }).stats?.overPct ?? Infinity)) : null;
    let best = { cmp, load: 1 };
    if (cmp.stats.overPct > pixelMaxPct) {
      for (const { f, load } of extra) {
        const next = compareImages(image(f.path), image(b.frame.path), { threshold });
        if (next.stats && next.stats.overPct < best.cmp.stats.overPct) best = { cmp: next, load };
      }
    }
    const { stats } = best.cmp;
    const diff = stats.over ? writeDiff(`${on.model}-${id}`, encodePng(diffImage(best.cmp.a, best.cmp.b, { threshold }))) : '';
    // Still different from every flags-off load: inconclusive where main differs from itself past the
    // gate, unless the flag differs by clearly more (twice main's own difference plus the gate).
    const noisy = noisePct !== null && noisePct > pixelMaxPct;
    const gated = stats.overPct <= pixelMaxPct ? 'pass' : noisy && stats.overPct <= 2 * noisePct + pixelMaxPct ? 'skip' : 'fail';
    const verdict = gated === 'pass' && !settled ? 'skip' : gated;
    const prefix = best.load > 1 && gated === 'pass' ? `matches flags-off load ${best.load}, one of main's own states; `
      : noisy && verdict === 'skip' ? 'inconclusive, main is not deterministic here: ' : '';
    const noiseNote = noisePct === null ? '' : `, main vs main up to ${noisePct}%`;
    add(area, `${id} pixels`, verdict,
      `${prefix}${stats.overPct}% > ${threshold}/255 vs flags-off load ${best.load} (max ${stats.max}, ${stats.isolatedPct}% isolated; gate ${pixelMaxPct}%${noiseNote})${unstable}`, diff || b.frame.path);
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
  // node:test's summary names each failure's file (`test at FILE:L:C`, then `✖ title`): key by file and
  // title there, since titles repeat across files. Without a summary, fall back to every failure line.
  const source = String(text);
  const summary = source.split(/^✖ failing tests:\s*$/m)[1];
  const names = new Set();
  let file = null;
  for (const line of (summary ?? source).split('\n')) {
    const at = /^test at (\S+?):\d+:\d+/.exec(line);
    if (at) { file = at[1]; continue; }
    const m = /^\s*✖\s+(.+?)(?:\s+\(\d[\d.]*m?s\))?\s*$/.exec(line) ?? /^\s*\d+\)\s+\[[\w-]+\]\s+›\s+(.+?)\s*$/.exec(line)
      ?? /^\s*not ok \d+ - (.+?)(?:\s+#.*)?\s*$/.exec(line);
    if (!m || /^failing tests:?$/i.test(m[1])) continue;
    names.add(summary && file ? `${file} › ${m[1]}` : m[1]);
    if (summary) file = null;
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
