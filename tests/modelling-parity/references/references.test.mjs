/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Offline checks for the modelling-parity reference manifest, the fetch
// verifier and the STEP reader behind the target specs (#9296, lane L5).
//   node --test tests/modelling-parity/references/references.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, symlinkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HERE, MANIFEST_PATH } from './lib.mjs';
import { elementCountsFromInfo, requireVerifiedReference } from './refresh-info.mjs';
import { verifyPath } from './fetch-references.mjs';
import { Model, parseStep, countRoofParts, storeyAtElevation } from './extract-target.mjs';

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

test('manifest entries are complete and licence claims are honest', () => {
  const ids = new Set();
  for (const r of manifest.references) {
    assert.ok(!ids.has(r.id), `duplicate id ${r.id}`);
    ids.add(r.id);
    assert.match(r.sha256, /^[0-9a-f]{64}$/, r.id);
    assert.ok(Number.isInteger(r.bytes) && r.bytes > 0, r.id);
    assert.ok(r.ifcSchema && r.authoringTool, r.id);
    assert.ok(['yes', 'no', 'unclear'].includes(r.licence.redistributable), r.id);
    assert.ok(r.licence.status && r.licence.url, r.id);
    if (r.licence.redistributable === 'yes') assert.ok(r.licence.spdx && r.licence.text, `${r.id}: 'yes' needs an SPDX id and the quoted notice`);
    if (r.licence.status === 'unknown') assert.equal(r.licence.text, null, `${r.id}: unknown licence must not carry a quote`);
    if (r.source.url) assert.ok(r.source.url.startsWith('https://'), r.id);
    assert.ok(r.source.url || r.fixture, `${r.id}: needs a download URL or a repo fixture`);
    assert.ok(r.ifc?.storeys && r.ifc.elementCounts, `${r.id}: run refresh-info.mjs`);
  }
});

test('no reference bytes are committed next to the manifest', () => {
  const allowed = /\.(json|mjs|md)$/;
  for (const name of readdirSync(HERE)) {
    if (name === '.cache') continue;
    assert.match(name, allowed, `${name} must not be committed here`);
  }
});

test('verifyPath detects missing, truncated and tampered files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-ref-'));
  try {
    const file = join(dir, 'x.ifc');
    const entry = { bytes: 5, sha256: '5d41402abc4b2a76b9719d911017c592'.padEnd(64, '0') };
    assert.equal((await verifyPath(file, entry)).state, 'missing');
    writeFileSync(file, 'hello');
    assert.equal((await verifyPath(file, entry)).state, 'mismatch'); // sha256 differs
    writeFileSync(file, 'hell');
    assert.match((await verifyPath(file, entry)).detail, /size 4/);
    const good = { bytes: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' };
    writeFileSync(file, 'hello');
    assert.equal((await verifyPath(file, good)).state, 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('STEP reader handles escapes, typed values, enums and references', () => {
  const e = parseStep("DATA;\n#1=IFCWALL('g',$,'K\\X2\\00FC\\X0\\che; (x)',#2,.NOTDEFINED.,IFCLABEL('t'),(1.5E-1,2.));\n#2=IFCCARTESIANPOINT((0.,1.));\nENDSEC;");
  assert.equal(e.size, 2);
  assert.deepEqual(e.get(1).args[3], { ref: 2 });
  assert.deepEqual(e.get(1).args[4], { en: 'NOTDEFINED' });
  assert.deepEqual(e.get(1).args[5], { t: 'IFCLABEL', v: 't' });
  assert.deepEqual(e.get(1).args[6], [0.15, 2]);
  const m = new Model("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCBUILDINGSTOREY('g',$,'K\\X2\\00FC\\X0\\che',$,$,$,$,$,.ELEMENT.,3.);\nENDSEC;");
  assert.equal(m.name(1), 'Küche');
  assert.equal(m.schema, 'IFC4');
});

test('committed target specs agree with the manifest', () => {
  for (const [id, file] of [['nibs-duplex-ifc2x3', 'f3-duplex-target.json'], ['kit-fzk-haus-ifc4', 'f2-fzk-haus-target.json']]) {
    const ref = manifest.references.find((r) => r.id === id);
    const t = JSON.parse(readFileSync(join(HERE, file), 'utf8'));
    assert.equal(t.source.sha256, ref.sha256, `${file}: stale against manifest sha256`);
    assert.equal(t.totals.storeys, ref.ifc.storeys.length, file);
    assert.equal(t.totals.walls, t.storeys.reduce((a, s) => a + s.walls.count, 0), file);
    assert.equal(t.totals.doors, t.storeys.reduce((a, s) => a + s.doors.count, 0), file);
    assert.equal(t.totals.windows, t.storeys.reduce((a, s) => a + s.windows.count, 0), file);
    assert.equal(t.totals.slabs, t.storeys.reduce((a, s) => a + s.slabs.count, 0), file);
    assert.equal(t.totals.spaces, t.spaces.length, file);
    assert.ok(t.tolerances.doorCountPerStorey, file);
  }
});

// #9304: equipment is a product even though its EXPRESS name contains Unit.
test('#9304 reference counts retain IfcUnitaryEquipment and exclude resource/type records', () => {
  assert.deepEqual(elementCountsFromInfo({ typeCounts: { IfcUnitaryEquipment: 2, IfcUnitaryEquipmentType: 1, IfcSIUnit: 3, IfcWall: 4, IfcWallType: 1 } }), { IfcUnitaryEquipment: 2, IfcWall: 4 });
});

test('#9304 reference CLIs execute through symlinks containing spaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity ref cli '));
  try {
    for (const [script, args, expected, output] of [
      ['fetch-references.mjs', ['--list', 'nibs-duplex-ifc2x3'], 0, /nibs-duplex-ifc2x3/],
      ['extract-target.mjs', ['not-a-reference'], 2, /unknown reference/],
    ]) {
      const link = join(dir, script);
      symlinkSync(join(HERE, script), link);
      const run = spawnSync(process.execPath, [link, ...args], { encoding: 'utf8', timeout: 10000 });
      assert.equal(run.status, expected, run.stderr);
      assert.match(run.stdout + run.stderr, output);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#9304 assigned feet use the conversion rather than its SI dependency', () => {
  const model = new Model("DATA;#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#2=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#1);#3=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,'foot',#2);#4=IFCUNITASSIGNMENT((#3));#5=IFCPROJECT('g',$,$,$,$,$,$,$,#4);ENDSEC;");
  assert.equal(model.lengthScale, 0.3048);
  assert.equal(model.areaScale, 0.3048 ** 2);
});
test('#9304 metadata refresh rejects missing and tampered reference bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-pin-'));
  try {
    const file = join(dir, 'missing.ifc');
    const entry = { id: 'test', bytes: 5, sha256: '0'.repeat(64) };
    await assert.rejects(requireVerifiedReference(file, entry), /missing/);
    writeFileSync(file, 'hello');
    await assert.rejects(requireVerifiedReference(file, entry), /mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#9304 roof slabs remain counted as parts when also selected as roots', () => {
  const model = new Model("DATA;#1=IFCROOF('r');#2=IFCSLAB('a');#3=IFCSLAB('b');#4=IFCRELAGGREGATES('g',$,$,$,#1,(#2,#3));ENDSEC;");
  assert.equal(countRoofParts(model, [1, 2, 3]), 2);
});

test('#9304 uncontained element assignment uses a five-centimetre world tolerance', () => {
  const levels = [{id: 1, placementZ: 0}, {id: 2, placementZ: 3}];
  assert.equal(storeyAtElevation(levels, 2.98), 2);
  assert.equal(storeyAtElevation(levels, 2.9), 1);
});
