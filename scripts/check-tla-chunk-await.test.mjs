#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for check-tla-chunk-await.mjs, the gate behind issue #2246.
 *
 * Two things are under test, and they pull in opposite directions:
 *
 *   1. The gate must still catch every shape it was written for -- the
 *      minified single-line importer that reproduced the real white screen,
 *      the pretty-printed multi-line one, and the bare side-effect import of
 *      a deferred chunk.
 *   2. The gate must not report success having inspected nothing. An assets
 *      directory that is missing, empty, or full of chunks among which not
 *      one is `__tla`-wrapped are all states in which every scan iterates
 *      over an empty set, so `violations` is empty because nothing was
 *      examined. Each must exit non-zero.
 *
 * The healthy-bundle cases exist to hold (2) honest: a guard that reds a
 * correct build gets switched off, which is worse than the vacuity it closes.
 *
 * Each case is a synthetic `apps/viewer/dist/assets` under a temp root, fed
 * to the gate via `--root`.
 *
 * Run: node --test scripts/check-tla-chunk-await.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'check-tla-chunk-await.mjs');
const ASSETS_REL = join('apps', 'viewer', 'dist', 'assets');

/**
 * Runs the gate over a synthetic assets dir.
 *
 * `chunks` is filename -> file text. `null` for the whole map means "do not
 * create the assets directory at all"; an empty map creates it with no .js
 * files in it.
 */
function runOn(chunks, { assetsRel = ASSETS_REL, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tla-chunk-await-'));
  try {
    if (chunks !== null) {
      const assets = join(dir, assetsRel);
      mkdirSync(assets, { recursive: true });
      for (const [name, text] of Object.entries(chunks)) {
        writeFileSync(join(assets, name), text);
      }
    }
    const r = spawnSync(process.execPath, [GATE, '--root', dir], {
      encoding: 'utf8',
      // Scrub the Vercel variables from the parent so a local run never
      // inherits a deployment layout, then apply the case's own.
      env: { ...process.env, VERCEL_DEPLOYMENT_ID: '', VERCEL_SKEW_PROTECTION_ENABLED: '', ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A `__tla`-wrapped chunk, in the plugin's real emitted (minified) shape: the
 * deferred binding is exported literally, unmangled, alongside the mangled
 * real exports.
 */
const TLA_CHUNK = `let __tla=Promise.resolve().then(async()=>{z=()=>1});let z;export{z,__tla};`;

/** The correctly-propagated importer: imports `__tla` aliased and folds it in. */
const GOOD_IMPORTER =
  `import{z as C,__tla as __tla_0}from"./store-abc.js";` +
  `let __tla=Promise.all([(()=>{try{return __tla_0}catch{}})()]).then(async()=>{C()});export{__tla};`;

/**
 * The same wrapped chunk as the plugin printed it before the minify patch:
 * SWC's pretty printer, one statement per line (production main-*.js shipped
 * 167k lines like this).
 */
const PRETTY_TLA_CHUNK = `let __tla = Promise.all([
    (()=>{ try { return __tla_0; } catch  {} })()
]).then(async ()=>{
    z = ()=>1;
});
let z;
export { z, __tla };
`;

test('a healthy bundle -- a __tla chunk and an importer that awaits it -- passes', () => {
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'pending-def.js': GOOD_IMPORTER });
  assert.equal(status, 0, out);
  assert.match(out, /✅ 0 chunks importing a __tla chunk without awaiting it/);
  // The success line must show it actually looked at the pair, not at nothing.
  assert.match(out, /1 static import\(s\) of a __tla-wrapped chunk checked/);
  // Both chunks count as wrapped: an importer that propagates the wait is
  // itself transformed, so it re-exports its own `__tla` -- the real shape.
  assert.match(out, /\(2 __tla-wrapped chunk\(s\) among 2 emitted chunk\(s\)\)/);
});

test('a healthy bundle whose __tla chunk is only imported dynamically passes', () => {
  // A lazy route is `import()`ed, never statically imported. The plugin makes
  // that shape safe by construction, so zero STATIC imports of a wrapped chunk
  // is a legitimate bundle and must not be treated as vacuity.
  const lazyImporter = `const load = () => import("./store-abc.js");
export { load };
`;
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'entry-def.js': lazyImporter });
  assert.equal(status, 0, out);
  assert.match(out, /0 static import\(s\) of a __tla-wrapped chunk checked/);
});

test('RED (#2246): a minified single-line importer with no __tla in its clause is caught', () => {
  // The exact shape the first version of the gate missed: every import
  // concatenated onto one unbroken line ahead of the first statement.
  const { status, out } = runOn({
    'store-abc.js': TLA_CHUNK,
    'pending-def.js': `import{z as C}from"./store-abc.js";C();`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /1 chunk\(s\) statically import a __tla-wrapped chunk without awaiting/);
  assert.match(out, /pending-def\.js {2}imports \{ z \} {2}from {2}store-abc\.js/);
});

test('RED: a pretty-printed multi-line importer with no __tla in its clause is caught', () => {
  const { status, out } = runOn({
    'store-abc.js': TLA_CHUNK,
    'panel-def.js': `import { z as C } from "./store-abc.js";\nC();\n`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /1 chunk\(s\) statically import a __tla-wrapped chunk without awaiting/);
});

test('RED: a bare side-effect import of a __tla-wrapped chunk is caught, under its own heading', () => {
  const { status, out } = runOn({
    'store-abc.js': TLA_CHUNK,
    'entry-def.js': `import"./store-abc.js";\n`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /1 chunk\(s\) import a __tla-wrapped chunk for its side effect only/);
  assert.match(out, /side effect IS the contract/);
});

test('RED: chunks emitted but not one __tla-wrapped chunk must fail, not tick', () => {
  // The vacuity this test file's second half exists for: with no wrapped
  // chunk, every scan below iterates over an empty set. Before the guard this
  // exact tree printed `✅ ... 0 static import(s) ... (0 __tla-wrapped chunk(s)
  // among 2 emitted chunk(s))` and exited 0 -- a green tick whose own numbers
  // said nothing had been checked.
  const { status, out } = runOn({
    'store-abc.js': `const z = () => 1;\nexport { z };\n`,
    'pending-def.js': `import{z as C}from"./store-abc.js";C();`,
  });
  assert.equal(status, 1, out);
  assert.doesNotMatch(out, /✅/);
  assert.match(out, /NOT ONE of\s*\n?them exports a `__tla` binding/);
  // ...and it never reaches the minification scan to report "all 0 minified".
  assert.doesNotMatch(out, /plugin-rewritten chunk\(s\) minified/);
  assert.match(out, /2 \.js chunk\(s\)/);
});

test('a Skew-Protected Vercel build is inspected in its per-deployment asset dir (#4886)', () => {
  const env = { VERCEL_DEPLOYMENT_ID: 'dpl_Test123', VERCEL_SKEW_PROTECTION_ENABLED: '1' };
  const assetsRel = join(ASSETS_REL, 'dpl_Test123');
  const healthy = runOn({ 'store-abc.js': TLA_CHUNK, 'LayersPanel-x.js': GOOD_IMPORTER }, { assetsRel, env });
  assert.equal(healthy.status, 0, healthy.out);
  // Chunks flat in assets/ while the build is nested means the gate would be
  // reading the wrong directory: it must refuse, not pass on nothing.
  const misplaced = runOn({ 'store-abc.js': TLA_CHUNK, 'LayersPanel-x.js': GOOD_IMPORTER }, { env });
  assert.notEqual(misplaced.status, 0, misplaced.out);
});

test('RED: an assets dir with no .js chunks at all must fail', () => {
  const { status, out } = runOn({});
  assert.equal(status, 1, out);
  assert.doesNotMatch(out, /✅/);
  assert.match(out, /contains no \.js chunks/);
});

test('RED: a missing assets dir must fail', () => {
  const { status, out } = runOn(null);
  assert.equal(status, 1, out);
  assert.doesNotMatch(out, /✅/);
  assert.match(out, /does not exist/);
});

test('RED: a __tla-wrapped chunk the plugin re-printed unminified is caught', () => {
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'main-def.js': PRETTY_TLA_CHUNK });
  assert.equal(status, 1, out);
  assert.doesNotMatch(out, /✅/);
  assert.match(out, /1 of 2 chunk\(s\) rewritten by the plugin were re-printed UNMINIFIED/);
  assert.match(out, /main-def\.js/);
});

test('multi-line string content in a minified __tla chunk is not mistaken for pretty-printing', () => {
  // The script templates and the esbuild-wasm chunk carry legitimately
  // multi-line template literals; only the plugin's own declaration counts.
  const withTemplate = `let s,t;let __tla=(async()=>{s=\`
    const x = 1
    if (x) {
      return x
    }
\`})();let s;export{s,__tla};`;
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'templates-def.js': withTemplate });
  assert.equal(status, 0, out);
  assert.match(out, /all 2 plugin-rewritten chunk\(s\) minified/);
});

// Entry chunks (main-*.js) and workers are rewritten by the plugin too, but
// export no `__tla`, and each worker build runs its own plugin instance. These
// are the plugin's pretty shapes for them, as the pre-patch build emitted.
const PRETTY_ENTRY = `import { z as C, __tla as __tla_0 } from "./store-abc.js";
Promise.all([
    (()=>{
        try {
            return __tla_0;
        } catch  {}
    })()
]).then(async ()=>{
    C();
});
`;
const PRETTY_WORKER = `(async ()=>{
    self.onmessage = async (e)=>{
        const m = await import(e.data).then(async (m)=>{
            await m.__tla;
            return m;
        });
        m.run();
    };
})();
`;
const MINIFIED_ENTRY =
  `import{z as C,__tla as __tla_0}from"./store-abc.js";` +
  `Promise.all([(()=>{try{return __tla_0}catch{}})()]).then(async()=>{C()});`;
const MINIFIED_WORKER =
  `(async()=>{self.onmessage=async e=>{(await import(e.data).then(async m=>{await m.__tla;return m})).run()}})();`;

test('RED: an unminified entry chunk that exports no __tla is still caught', () => {
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'main-def.js': PRETTY_ENTRY });
  assert.equal(status, 1, out);
  assert.match(out, /1 of 2 chunk\(s\) rewritten by the plugin were re-printed UNMINIFIED/);
  assert.match(out, /main-def\.js/);
});

test('RED: an unminified worker chunk (dynamic-import rewrite only) is caught', () => {
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'parser.worker-def.js': PRETTY_WORKER });
  assert.equal(status, 1, out);
  assert.match(out, /parser\.worker-def\.js/);
});

test('minified entry and worker chunks pass and are counted', () => {
  const { status, out } = runOn({
    'store-abc.js': TLA_CHUNK,
    'main-def.js': MINIFIED_ENTRY,
    'parser.worker-def.js': MINIFIED_WORKER,
  });
  assert.equal(status, 0, out);
  assert.match(out, /all 3 plugin-rewritten chunk\(s\) minified/);
});

test('a minified chunk that merely QUOTES the pretty wrapper is not flagged', () => {
  // E.g. the bundled changelog describing this fix, both inline and inside a
  // multi-line template literal where it lands at a line start.
  const quoting =
    'let __tla=Promise.resolve().then(async()=>{z=()=>1});let z;' +
    'const a="the plugin printed let __tla = Promise.all( pretty",b=`fixed:\n' +
    'let __tla = Promise.all([\n    try {\n        return __tla_0;\n    await m.__tla;\n`;' +
    'export{z,a,b,__tla};';
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'changelog-def.js': quoting });
  assert.equal(status, 0, out);
  assert.match(out, /all 2 plugin-rewritten chunk\(s\) minified/);
});

test('RED: a PRETTY chunk that quotes the minified forms is still caught', () => {
  // The mirror case: the chunk really was re-printed pretty, but a string in
  // it happens to contain every minified form. Only the prologue is judged.
  const quotingMinified = `import { z as C, __tla as __tla_0 } from "./store-abc.js";
let __tla = Promise.all([
    (()=>{
        try {
            return __tla_0;
        } catch  {}
    })()
]).then(async ()=>{
    s = "let __tla=Promise.all( try{return __tla_0} await m.__tla;return m}";
    C();
});
let s;
export { s, __tla };
`;
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'changelog-def.js': quotingMinified });
  assert.equal(status, 1, out);
  assert.match(out, /1 of 2 chunk\(s\) rewritten by the plugin were re-printed UNMINIFIED/);
  assert.match(out, /changelog-def\.js/);
});

test('RED: a __tla chunk with too little leading code to judge fails instead of passing blind', () => {
  // Starts with a literal, so its prologue is empty: neither pretty nor
  // minified can be read off it, and that must not count as minified.
  const opaque = `\`let __tla=\`;export{__tla};`;
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'other-def.js': opaque });
  assert.equal(status, 1, out);
  assert.doesNotMatch(out, /✅/);
  assert.match(out, /too little leading code/);
});

test('an untouched chunk that only mentions __tla inside a string is not scanned', () => {
  // Its prologue (`const help=`) is too short to judge, so scanning it would
  // fail a healthy build. The plugin never rewrote it: no __tla in its leading
  // code, no __tla export, no dynamic-import rewrite.
  const { status, out } = runOn({
    'store-abc.js': TLA_CHUNK,
    'help-def.js': 'const help="docs __tla";export{help};',
  });
  assert.equal(status, 0, out);
  assert.match(out, /all 1 plugin-rewritten chunk\(s\) minified/);
});

// Actual 179-byte CodeEditor barrel from the #7041 Vite 8.3.2 build (#7377).
const REEXPORT_BARREL = 'import{__tla as __tla_0}from"./CodeEditor-inSPMxdp.js";export{t as CodeEditor}from"./CodeEditor-inSPMxdp.js";Promise.all([(()=>{try{return __tla_0}catch{}})()]).then(async()=>{});';

test('#7377: actual emitted re-export barrel reaches the minified wrapper', () => {
  const result = runOn({ 'CodeEditor-inSPMxdp.js': TLA_CHUNK, 'CodeEditor.js': REEXPORT_BARREL });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /all 2 plugin-rewritten chunk\(s\) minified/);
});

test('#7377: alternating named, star and namespace re-exports retain formatting evidence', () => {
  const barrel = 'export{z as value}from"./store-abc.js";import{__tla as __tla_0}from"./store-abc.js";export*from"./plain.js";export*as space from"./plain.js";Promise.all([(()=>{try{return __tla_0}catch{}})()]).then(async()=>{});';
  const result = runOn({ 'store-abc.js': TLA_CHUNK, 'plain.js': 'export const z=1;', 'barrel.js': barrel });
  assert.equal(result.status, 0, result.out);
});

test('#7377 inverse: pretty re-export clauses and pretty wrappers still refuse', () => {
  const mutations = [
    REEXPORT_BARREL.replace('export{t as CodeEditor}', 'export { t as CodeEditor }'),
    REEXPORT_BARREL.replace('Promise.all([', 'Promise.all([\n '),
  ];
  for (const barrel of mutations) {
    const result = runOn({ 'CodeEditor-inSPMxdp.js': TLA_CHUNK, 'barrel.js': barrel });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /UNMINIFIED/);
  }
});

test('#7377 inverse: a re-export specifier cannot supply the eight punctuation marks', () => {
  const result = runOn({
    'store-abc.js': TLA_CHUNK,
    'barrel.js': 'export{__tla}from"./pretend=,{}();:[].js";',
  });
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /too little leading code/);
});

test('#7377: literal, template, comment and escaped specifier traps stay opaque', async () => {
  const { chunkFormatting, prologue } = await import('./lib/tla-chunk-prologue.mjs');
  const traps = [
    'export const x="export{__tla}from\'x\';Promise.all([(()=>{})()])";',
    'export const x=`export{__tla}from"x";Promise.all([(()=>{})()])`;',
    'export/* export{__tla}from"x";Promise.all([(()=>{})()]) */{};',
    String.raw`export{z}from"x\";Promise.all([(()=>{})()])";`,
    'export{"Promise.all([(()=>{})()])" as z}from"x";',
  ];
  for (const trap of traps) {
    assert.equal(chunkFormatting(trap), 'unknown', trap);
    assert.doesNotMatch(prologue(trap), /Promise\.all/, trap);
  }
});
