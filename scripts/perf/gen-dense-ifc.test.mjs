/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #10264: the synthetic dense-IFC generator must be deterministic (a repro
// that changes between runs reproduces nothing) and must emit well-formed STEP
// whose per-kind density matches what the docs table promises.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Guarded load, not a static import: the revert oracle removes this PR's production files, and a
// static import of a removed module fails the whole file at LOAD, which the oracle cannot tell
// from a broken test. With the guard, every test fails by an ordinary assertion instead.
const GEN = new URL('./gen-dense-ifc.mjs', import.meta.url);
const genModule = existsSync(GEN) ? await import(GEN.href) : null;
function gen() { assert.ok(genModule, 'scripts/perf/gen-dense-ifc.mjs does not exist'); return genModule; }
const generateDenseIfc = (...a) => gen().generateDenseIfc(...a);
const writeDenseIfc = (...a) => gen().writeDenseIfc(...a);
const real = (...a) => gen().real(...a);
const guid = (...a) => gen().guid(...a);

const render = (options) => {
  const parts = [];
  const stats = generateDenseIfc((s) => parts.push(s), options);
  return { text: parts.join(''), stats };
};
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('#10264 same arguments give byte-identical files; another seed does not', () => {
  for (const kind of ['tfs', 'brep']) {
    const a = render({ kind, elements: 6, rings: 6, segs: 8, psets: 1 });
    const b = render({ kind, elements: 6, rings: 6, segs: 8, psets: 1 });
    assert.equal(sha(a.text), sha(b.text), `${kind}: two runs differ`);
    const c = render({ kind, elements: 6, rings: 6, segs: 8, psets: 1, seed: 2 });
    assert.notEqual(sha(a.text), sha(c.text), `${kind}: seed has no effect`);
  }
});

test('#10264 the file written to disk equals the streamed text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-dense-ifc-'));
  try {
    const out = join(dir, 'x.ifc');
    const stats = writeDenseIfc(out, { kind: 'brep', elements: 3, rings: 5, segs: 6 });
    const disk = readFileSync(out, 'utf8');
    assert.equal(disk, render({ kind: 'brep', elements: 3, rings: 5, segs: 6 }).text);
    assert.equal(Buffer.byteLength(disk), stats.bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Minimal STEP well-formedness: contiguous ids, every #ref defined, unique GlobalIds. */
function checkStep(text, schema) {
  assert.match(text, new RegExp(`^ISO-10303-21;\\nHEADER;\\n[\\s\\S]*FILE_SCHEMA\\(\\('${schema}'\\)\\);\\nENDSEC;\\nDATA;\\n`));
  assert.ok(text.endsWith('ENDSEC;\nEND-ISO-10303-21;\n'));
  const data = text.slice(text.indexOf('DATA;\n') + 6, text.lastIndexOf('ENDSEC;'));
  const lines = data.split('\n').filter(Boolean);
  const types = new Map();
  lines.forEach((line, i) => {
    const m = /^#(\d+)=([A-Z0-9]+)\((.*)\);$/.exec(line);
    assert.ok(m, `malformed record: ${line.slice(0, 120)}`);
    assert.equal(Number(m[1]), i + 1, 'ids are contiguous from 1');
    types.set(Number(m[1]), m[2]);
  });
  for (const line of lines) {
    for (const r of line.slice(line.indexOf('=')).matchAll(/#(\d+)/g)) assert.ok(types.has(Number(r[1])), `dangling #${r[1]}`);
  }
  const gids = [...data.matchAll(/\('([0-9A-Za-z_$]{22})',#/g)].map((m) => m[1]);
  assert.equal(new Set(gids).size, gids.length, 'GlobalIds are unique');
  return [...types.values()];
}

test('#10264 tfs output is well-formed IFC4 with the advertised triangle count', () => {
  const rings = 6, segs = 8, elements = 7;
  const { text, stats } = render({ kind: 'tfs', elements, rings, segs, psets: 2 });
  const types = checkStep(text, 'IFC4');
  const count = (t) => types.filter((x) => x === t).length;
  assert.equal(count('IFCBUILDINGELEMENTPROXY'), elements);
  assert.equal(count('IFCTRIANGULATEDFACESET'), elements);
  assert.equal(count('IFCPROPERTYSET'), elements * 2);
  assert.equal(count('IFCRELCONTAINEDINSPATIALSTRUCTURE'), 1);
  assert.equal(stats.triangles, elements * 2 * segs * (rings - 1));
  // Index triples are 1-based into a list of 2 + (rings-1)*segs points.
  const maxIndex = Math.max(...[...text.matchAll(/IFCTRIANGULATEDFACESET\(#\d+,\$,\.T\.,\((.*)\),\$\)/g)]
    .flatMap((m) => m[1].match(/\d+/g).map(Number)));
  assert.equal(maxIndex, 2 + (rings - 1) * segs);
});

test('#10264 brep output is well-formed IFC2X3, one face per triangle', () => {
  const rings = 5, segs = 6, elements = 4;
  const { text, stats } = render({ kind: 'brep', elements, rings, segs });
  const types = checkStep(text, 'IFC2X3');
  const tris = elements * 2 * segs * (rings - 1);
  assert.equal(stats.triangles, tris);
  assert.equal(types.filter((t) => t === 'IFCFACE').length, tris);
  assert.equal(types.filter((t) => t === 'IFCFACETEDBREP').length, elements);
  assert.equal(stats.entities, types.length);
});

test('#10264 --target-mb stops just past the target at the documented density', () => {
  // Default mesh (24x48). Documented: tfs ~40.6 k triangles/MB, ~150 entities/MB;
  // brep ~6.1-7.1 k triangles/MB, ~21-25 k entities/MB (higher on small files).
  const tfs = render({ kind: 'tfs', targetBytes: 2e6 }).stats;
  assert.ok(tfs.bytes >= 2e6 && tfs.bytes < 2e6 + 60e3, `tfs bytes ${tfs.bytes}`);
  assert.ok(tfs.trianglesPerMB > 39e3 && tfs.trianglesPerMB < 42e3, `tfs ${tfs.trianglesPerMB} tri/MB`);
  const brep = render({ kind: 'brep', targetBytes: 2e6 }).stats;
  assert.ok(brep.trianglesPerMB > 5.5e3 && brep.trianglesPerMB < 7.5e3, `brep ${brep.trianglesPerMB} tri/MB`);
  assert.ok(brep.entitiesPerMB > 20e3, `brep ${brep.entitiesPerMB} entities/MB`);
});

test('#10264 STEP reals and GlobalIds are encoded as the schema requires', () => {
  assert.equal(real(1), '1.0');
  assert.equal(real(-0.0001), '0.');
  assert.equal(real(2.5), '2.5');
  assert.equal(real(-1.23456), '-1.235');
  assert.match(guid(1), /^[0-3][0-9A-Za-z_$]{21}$/);
  assert.notEqual(guid(1), guid(2));
});

test('#10264 rejects arguments that cannot produce a valid file', () => {
  assert.throws(() => render({ kind: 'tfs', schema: 'IFC2X3', elements: 1 }), /needs IFC4/);
  assert.throws(() => render({ kind: 'mesh', elements: 1 }), /unknown kind/);
  assert.throws(() => render({ kind: 'tfs' }), /elements or targetBytes/);
  // CLI arguments arrive as Number('abc') = NaN; that must fail, not emit NaN coordinates or skip psets.
  assert.throws(() => render({ kind: 'tfs', elements: 1, psets: NaN }), /psets must be an integer/);
  assert.throws(() => render({ kind: 'tfs', elements: 1, grid: NaN }), /grid must be a positive number/);
  assert.throws(() => render({ kind: 'tfs', elements: 1, rings: 2.5 }), /rings must be an integer/);
  assert.throws(() => render({ kind: 'tfs', targetBytes: NaN, elements: 1 }), /targetBytes must be a positive number/);
});

test('#10264 an existing directory as output fails cleanly and leaves no .tmp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-dense-ifc-'));
  try {
    const target = join(dir, 'sub');
    mkdirSync(target);
    assert.throws(() => writeDenseIfc(target, { kind: 'tfs', elements: 1 }), /is a directory/);
    assert.equal(existsSync(`${target}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#10264 the CLI rejects numbers that are not plain decimals', () => {
  gen();
  const dir = mkdtempSync(join(tmpdir(), 'gen-dense-ifc-'));
  try {
    for (const args of [['--elements', ''], ['--elements', '1', '--rings', '0x4'], ['--elements', '1', '--psets', 'abc'], ['--target-mb', '1e3']]) {
      const r = spawnSync(process.execPath, [join(import.meta.dirname, 'gen-dense-ifc.mjs'), join(dir, 'x.ifc'), ...args], { encoding: 'utf8' });
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /not a plain non-negative number/);
      assert.equal(existsSync(join(dir, 'x.ifc')), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#10264 an unsupported --schema is rejected for both kinds before anything is written (review on #10415)', () => {
  gen();
  for (const kind of ['tfs', 'brep']) assert.throws(() => render({ kind, elements: 1, schema: 'IFC9' }), /unsupported schema IFC9/);
  const dir = mkdtempSync(join(tmpdir(), 'gen-dense-ifc-'));
  try {
    for (const kind of ['tfs', 'brep']) {
      const r = spawnSync(process.execPath, [join(import.meta.dirname, 'gen-dense-ifc.mjs'), join(dir, 'x.ifc'), '--kind', kind, '--schema', 'IFC9', '--elements', '1'], { encoding: 'utf8' });
      assert.equal(r.status, 2, `${kind}: ${r.stderr}`);
      assert.match(r.stderr, /unsupported --schema 'IFC9'/);
      assert.equal(existsSync(join(dir, 'x.ifc')), false);
      assert.equal(existsSync(join(dir, 'x.ifc.tmp')), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
