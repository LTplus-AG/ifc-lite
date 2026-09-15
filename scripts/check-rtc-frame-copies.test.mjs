/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANONICAL,
  CANONICAL_CALL_EXPRESSIONS,
  DISTINCT_FRAME_EXPRESSIONS,
  validateProseMentions,
  scanRepo,
  scanText,
} from './check-rtc-frame-copies.mjs';

const copies = [
  'const rtc = info.wasmRtcOffset;',
  'const rtc: Vector3 = info.wasmRtcOffset;',
  'const offset = info.wasmRtcOffset;',
  'const offset = info.wasmRtcOffset; /* ifcToViewerAxes */',
  'const { wasmRtcOffset } = info;',
  'const up = info.wasmRtcOffset?.z ?? 0;',
  'const yup = { x: rtc.x, y: rtc.z, z: -rtc.y };',
  'return [point.x, point.z, -point.y];',
  'return { x: p.x, y: p.z, z: 0 - p.y };',
  'return { x: p.x, y: 0 - p.z, z: p.y };',
  '  y: p.z,',
  '  z: 0 - p.y,',
];

for (const copy of copies) {
  test(`detects ${copy}`, () => assert.ok(scanText('apps/viewer/src/probe.ts', copy).length > 0));
}

function syntheticRepo(overrides, exceptions = []) {
  const padding = Array.from({ length: 120 }, (_, index) => `apps/viewer/src/pad-${index}.ts`);
  const files = [...new Set([...padding, ...Object.keys(overrides)])];
  return scanRepo(files, (file) => overrides[file] ?? '', exceptions);
}

test('the canonical module is the sole implementation', () => {
  const source = 'return { x: point.x, y: point.z, z: 0 - point.y };';
  assert.deepEqual(syntheticRepo({ [CANONICAL]: source }).violations, []);
});

test('detects a conventional multiline axis object', () => {
  const source = 'return {\n  x: point.x, // unchanged\n  y: point.z, // up\n  z: 0 - point.y, // north\n};';
  assert.ok(scanText('apps/viewer/src/probe.ts', source).length >= 2);
});

test('detects aliases and axis objects split across line boundaries', () => {
  const source = [
    'const rtc =',
    '  coordinateInfo.wasmRtcOffset;',
    'const yup = {',
    '  x: rtc.x,',
    '  y: rtc.z,',
    '  z: -rtc.y,',
    '};',
  ].join('\n');
  const hits = scanText('apps/viewer/src/probe.ts', source);
  assert.ok(hits.some((hit) => hit.pattern === 'raw RTC offset alias'));
  assert.ok(hits.some((hit) => hit.pattern === 'IFC-to-viewer axis object'));
});

test('an actual canonical call is allowed, but naming it in a comment is not', () => {
  const [good] = CANONICAL_CALL_EXPRESSIONS;
  assert.deepEqual(syntheticRepo({ [good.file]: good.text }, [good]).violations, []);
  const bad = 'const offset = info.wasmRtcOffset; /* ifcToViewerAxes */';
  assert.ok(syntheticRepo({ 'apps/viewer/src/bad.ts': bad }).violations.length > 0);
  const earlierCall = 'const basis = ifcToViewerAxes(ZERO); const offset = info.wasmRtcOffset;';
  assert.ok(syntheticRepo({ 'apps/viewer/src/earlier.ts': earlierCall }).violations.length > 0);
  const secondDeclarator = 'const converted = ifcToViewerAxes(ZERO), raw = (info.wasmRtcOffset);';
  assert.ok(syntheticRepo({ 'apps/viewer/src/declarator.ts': secondDeclarator }).violations.length > 0);
  const trailingExpression = 'const raw = ifcToViewerAxes(ZERO) && (info.wasmRtcOffset);';
  assert.ok(syntheticRepo({ 'apps/viewer/src/expression.ts': trailingExpression }).violations.length > 0);
});

test('prose registry accepts only inert, exact line comments', () => {
  assert.throws(
    () => validateProseMentions([{ file: 'x.ts', text: 'const rtc = info.wasmRtcOffset;' }]),
    /trimmed \/\/ line comment/,
  );
  assert.throws(
    () => validateProseMentions([{ file: 'x.ts', text: '// $' + '{info.wasmRtcOffset?.z}' }]),
    /unsafe/,
  );
  assert.throws(
    () => validateProseMentions([{ file: 'x.ts', text: '// rtc.x, rtc.z, -rtc.y */ code()' }]),
    /unsafe/,
  );
});

test('exact distinct-frame lines do not create a path-wide exemption', () => {
  const [entry] = DISTINCT_FRAME_EXPRESSIONS;
  const source = `${entry.text}\nconst other = info.wasmRtcOffset?.z;`;
  const result = syntheticRepo({ [entry.file]: source }, [entry]);
  assert.ok(result.violations.length > 0);
  assert.ok(result.violations.every((hit) => hit.line === 2));
  assert.equal(result.stale.length, 0);
});

test('one registry entry excuses only one matching occurrence', () => {
  const [entry] = DISTINCT_FRAME_EXPRESSIONS;
  const result = syntheticRepo({ [entry.file]: `${entry.text}\n${entry.text}` }, [entry]);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.line, 2);
  assert.deepEqual(result.stale, []);
});

test('registry entries ratchet when their exact line disappears', () => {
  const [entry] = DISTINCT_FRAME_EXPRESSIONS;
  const result = syntheticRepo({ [entry.file]: '// changed' }, [entry]);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.stale, [entry]);
});

test('refuses a vacuous scan', () => {
  assert.throws(() => scanRepo(['apps/viewer/src/one.ts'], () => ''), /suspiciously small/);
});

test('the live viewer has no unregistered copy or stale exception', () => {
  const result = scanRepo();
  assert.ok(result.scanned > 100);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.stale, []);
});
