// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dependencies } from './retained-loader-dependencies.mjs';
import { parse } from './retained-loader-syntax.mjs';

const scan = (source, assets = {}) => dependencies(new Map([
  ['entry.mjs', Buffer.from(source)], ...Object.entries(assets).map(([name, text]) => [name, Buffer.from(text)]),
]));

test('R1/R2 lexical decoys are not runtime requests; templates and escapes resolve actual requests (#7955)', () => {
  assert.deepEqual(scan('const ns={"./absent_bg.js":{}}; const text="import(globalThis.x)"; const r=/fetch\\(unknown\\)/; const t=`new Worker(bad)`; /* import("./absent") */'), []);
  const edges = scan('const url="https://host//x"; /* ignored */ import(`./real.mjs`); import("./re\\u0061l.mjs");', { 'real.mjs': 'export {};' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, 'real.mjs');
});

test('R3 immutable variable-backed URL/fetch/Worker forms retain their literal dependency (#7955)', () => {
  const edges = scan('const path="./payload.wasm"; const url=new URL(path, import.meta.url); fetch(url); new Worker(new URL("./worker.mjs", import.meta.url));', { 'payload.wasm': 'fixture', 'worker.mjs': 'export {};' });
  assert.deepEqual(edges.map(e => e.to), ['payload.wasm', 'worker.mjs']);
});

for (const source of [
  'const url="https://host"; import(globalThis.x);',
  'const t=`value ${import(globalThis.x)}`;',
  'const r=/https:\\/\\/host/; import(globalThis.x);',
  'const path=globalThis.x; fetch(path);',
  'const path="./payload.wasm"; function changed(path) { fetch(path); }',
  'let path="./payload.wasm"; path=globalThis.x; fetch(path);',
  'const f=fetch; f(globalThis.x);',
  'const f=globalThis.fetch; f(globalThis.x);',
  'run(fetch, globalThis.x);',
  'new Worker(new URL(globalThis.x, import.meta.url));',
  'fetch(`${globalThis.x}.wasm`);',
]) test(`R2/R3 fail closed: ${source} (#7955)`, () => {
  assert.doesNotThrow(() => parse('fixture.mjs', source));
  assert.throws(() => scan(source, { 'payload.wasm': 'fixture' }), /Unresolved|Escaped|Unknown/);
});

for (const [kind, filename, asset] of [
  ['wasm-bindgen', 'pkg-retained/ifc-lite.js', 'pkg-retained/ifc-lite_bg.wasm'],
  ['emscripten', 'ifclite_smlib_browser.mjs', 'ifclite_smlib_browser.wasm'],
]) {
  const source = readFileSync(new URL(`../fixtures/retained-loaders/${kind}.${kind === 'emscripten' ? 'txt' : 'mjs'}`, import.meta.url), 'utf8');
  const map = text => new Map([[filename, Buffer.from(text)], [asset, Buffer.from('fixture')],
    ['pkg-retained/snippets/fixture/js/retained-driver.mjs', Buffer.from('export {};')]]);
  test(`R3 ${kind} accepted generated flow is bound to literal roots and all sink/binding syntax (#7955)`, () => {
    assert.ok(dependencies(map(source)).some(edge => edge.to === asset));
    assert.ok(dependencies(map('// https://host/ comment\n'+source)).some(edge => edge.to === asset));
    const edits = kind === 'wasm-bindgen' ? [
      source.replace('fetch(module_or_path)', 'fetch(globalThis.asset)'),
      source.replace("module_or_path = new URL", "module_or_path = globalThis.asset; module_or_path = new URL"),
      source.replace('ifc-lite_bg.wasm', 'other.wasm'),
    ] : [
      source.replace('fetch(binaryFile,', 'fetch(globalThis.asset,'),
      source.replace('async function getWasmBinary(binaryFile){', 'async function getWasmBinary(binaryFile){binaryFile=globalThis.asset;'),
      source.replace('ifclite_smlib_browser.wasm', 'other.wasm'),
    ];
    for (const changed of [...edits, source+'\nfetch(globalThis.extra);', source+'\nconst f=fetch; f(globalThis.extra);']) {
      assert.throws(() => dependencies(map(changed)));
    }
    const missing = map(source); missing.delete(asset);
    assert.throws(() => dependencies(missing), /dependency/);
  });
}

for (const source of [
  'const path="./payload.wasm"; function load({...path}) { fetch(path); }',
  'const path="./payload.wasm"; { const [,path]=globalThis.paths; fetch(path); }',
  'const path="./payload.wasm"; try {} catch (path) { fetch(path); }',
  'const path="./payload.wasm"; { function path() {} fetch(path); }',
  'const path="./payload.wasm"; { class path {} fetch(path); }',
  'const path="./payload.wasm"; const load=function path() { fetch(path); };',
  'const path="./payload.wasm"; const load=class path { method() { fetch(path); } };',
  'function unused() { const path="./payload.wasm"; } const url=path; fetch(url);',
  '{ const path="./payload.wasm"; } fetch(path);',
  'switch(globalThis.kind) { case 0: const path="./payload.wasm"; fetch(path); }',
]) test(`R2-F1 unsupported/shadowed binding refuses: ${source} (#7955)`, () => {
  assert.doesNotThrow(() => parse('scope.mjs', source));
  assert.throws(() => scan(source, { 'payload.wasm': 'fixture' }), /Unresolved asset locator/);
});

test('R2-F1 renamed destructuring property names do not shadow visible literal bindings (#7955)', () => {
  const edges = scan(`
    const path = './payload.wasm';
    function load({path: supplied}) { const copy = path; return fetch(copy); }
    { const {other} = globalThis.config; fetch(path); }
    function own() { const local = './payload.wasm'; return fetch(new URL(local, import.meta.url)); }
  `, { 'payload.wasm': 'fixture' });
  assert.deepEqual(edges.map(edge => edge.to), ['payload.wasm']);
});

test('R2-F2 imports require module prefixes; fetch paths have URL semantics (#7955)', () => {
  const assets = { 'runtime.mjs': 'export {};', '.runtime.mjs': 'export {};', '..runtime.mjs': 'export {};' };
  for (const specifier of ['runtime.mjs', '.runtime.mjs', '..runtime.mjs']) {
    for (const source of [`import(${JSON.stringify(specifier)});`, `import ${JSON.stringify(specifier)};`, `export * from ${JSON.stringify(specifier)};`]) {
      assert.throws(() => scan(source, assets), /Bare .*import/);
    }
  }
  assert.deepEqual(scan('fetch("runtime.mjs"); import("./runtime.mjs");', assets).map(edge => edge.to), ['runtime.mjs', 'runtime.mjs']);
  assert.throws(() => dependencies(new Map([
    ['ifclite_smlib_browser.mjs', Buffer.from('import("module");')],
  ])), /Bare dynamic import/); // Generated Node exception needs its real syntax profile.
});

test('R3-F2 distinct document/worker/module bases cannot be inferred from a raw fetch string (#7955)', () => {
  const documentBase = 'https://host.invalid/pages/test.html';
  const workerBase = 'https://host.invalid/workers/main.mjs';
  const moduleBase = 'https://host.invalid/smlib/pkg-retained/nested/entry.mjs';
  assert.equal(new Set([documentBase, workerBase, moduleBase].map(base => new URL('./payload.wasm', base).href)).size, 3);
  const assets = new Map([
    ['pkg-retained/nested/entry.mjs', Buffer.from("fetch('./payload.wasm');")],
    ['pkg-retained/nested/payload.wasm', Buffer.from('module fixture')],
    ['payload.wasm', Buffer.from('other fixture')],
  ]);
  assert.throws(() => dependencies(assets), /execution.context.relative/);
});
