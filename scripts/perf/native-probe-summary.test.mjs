/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { probeResult } from './native-hosted-plan.mjs';
import { probeSummary, requireSummaryDiagnostics } from './native-probe-summary.mjs';
const directory = new URL('./evidence/native-canonical-summary-6537/fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
function capture(family) {
  const fixture = manifest.rows.find(row => row.family === family);
  for (const row of fixture.raw) {
    const bytes = readFileSync(new URL(row.path, directory));
    assert.equal(bytes.length, row.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
  }
  const result = probeResult(readFileSync(new URL(`${family}.stdout`, directory), 'utf8'), fixture.file);
  const raw = readFileSync(new URL(`${family}.stderr`, directory), 'utf8');
  assert.ok(raw.startsWith(fixture.cargoFreshnessPrefix));
  return { fixture, result, text: raw.slice(fixture.cargoFreshnessPrefix.length), raw };
}
for (const family of ['house', 'csg', 'heavy-csg']) test(`#6537 canonical stderr accepts retained real ${family} output, not empty stderr`, () => {
  const { fixture, result, text, raw } = capture(family);
  const summary = probeSummary(text, result, fixture);
  assert.equal(summary.status, 'complete-canonical-summary');
  assert.equal(summary.diagnostics.csgFailures, result.csgFailures);
  assert.equal(summary.diagnostics.degenerateDropped, result.degenerateDropped);
  if (family === 'house') assert.equal(result.meshes, 285);
  if (family === 'csg') assert.deepEqual(summary.diagnostics, { csgFailures: 41, productsWithFailures: 6, degenerateDropped: 6 });
  // Old captures retain their Cargo prefix verbatim. Production FD summaries
  // must refuse it: only this historical-data adapter extracts the component.
  if (fixture.cargoFreshnessPrefix) assert.throws(() => probeSummary(raw, result, fixture), /summary refused/);
});
test('#6537 unknown, repeated, warning, compile and truncated diagnostic lines never become a canonical summary', () => {
  const { fixture, result, text } = capture('house');
  for (const changed of ['', text.slice(0, -1), text.replaceAll('\n', '\r\n'),
    'warning: fallback\n' + text, 'Compiling processing\n' + text, text + 'error: hidden failure\n',
    text + 'unrecognized diagnostic\n', text + text, text.replace('best-of-5', 'best-of-4'),
    text.replace('1 fixture(s)', '2 fixture(s)'), text.replace('perf_probe:', 'other_probe:'),
    text.replace('  phase                    ms        % total\n', '')]) {
    assert.throws(() => probeSummary(changed, result, fixture), /summary refused/);
  }
});
test('#6537 stderr count, phase, hash, five-iteration total and wall mismatches refuse independently', () => {
  const { fixture, result, text } = capture('house');
  for (const changed of [text.replace('285 meshes', '284 meshes'), text.replace('44249 entities', '44248 entities'),
    text.replace('35940 verts', '35941 verts'), text.replace('20322 tris', '20323 tris'),
    text.replace('best total 16 ms', 'best total 17 ms'), text.replace('[21, 18, 18, 16, 16]', '[21, 18, 18, 16, 17]'),
    text.replace('c4d504b83ff698ea', '0000000000000000'), text.replace('22.621497', '22.621498'),
    text.replace(/(parse \(pre-geometry\) +)6/, '$15'), text.replace('37.5%', '37.6%'),
    text.replace('6.2%', '12.5%'), text.replace('2.03 Mtris/s', '2.04 Mtris/s'),
    text.replace('85.1% memoized', '85.2% memoized'), text.replace('51788 hits', '51787 hits')]) {
    assert.throws(() => probeSummary(changed, result, fixture), /summary refused/);
  }
  const badResult = { ...result, parseMs: result.parseMs + 1 };
  assert.throws(() => probeSummary(text, badResult, fixture), /integer value mismatch/);
  assert.throws(() => probeSummary(text, result, { ...fixture, file: '/different.ifc' }), /fixture binding/);
});
test('#6537 optional diagnostics follow actual count predicates and exact order', () => {
  const { fixture, result, text } = capture('csg');
  for (const changed of [text.replace(/  csg failures[^\n]*\n/, ''), text.replace(/  degenerate dropped[^\n]*\n/, ''),
    text.replace('41 across 6', '42 across 6'), text.replace('41 across 6', '41 across 42'),
    text.replace('degenerate dropped    6', 'degenerate dropped    5'),
    text.replace(/(  csg failures[^\n]*\n)(  degenerate dropped[^\n]*\n)/, '$2$1'),
    text.replace(/(  csg failures[^\n]*\n)/, '$1$1')]) assert.throws(() => probeSummary(changed, result, fixture));
  const changedAttribution = probeSummary(text.replace('41 across 6', '41 across 7'), result, fixture);
  const original = probeSummary(text, result, fixture);
  assert.equal(changedAttribution.diagnostics.productsWithFailures, 7);
  assert.throws(() => requireSummaryDiagnostics(original, changedAttribution), /attribution differs/);
  requireSummaryDiagnostics(original, original, original);
  assert.throws(() => requireSummaryDiagnostics(original, original, changedAttribution), /attribution differs/);
});
test('#6537 constructed optional case preserves unattributed-only failures, nonzero brep and absent cache invariants', () => {
  // Constructed contract input, not a claimed engine/model result: all four
  // optional branches are derived from observable scalar count predicates.
  const { fixture, result, text } = capture('house');
  const optional = { ...result, facetedBrepMs: 2, pointCacheHits: 0, pointCacheMisses: 0,
    csgFailures: 4, degenerateDropped: 2 };
  const body = text.replace(/(  geometry[^\n]*\n)/, '$1    - faceted-brep             2    12.5%   (observability build)\n')
    .replace(/  brep point-cache[^\n]*\n/, '') + '  csg failures          4 across 0 products\n  degenerate dropped    2\n';
  const summary = probeSummary(body, optional, fixture);
  assert.deepEqual(summary.diagnostics, { csgFailures: 4, productsWithFailures: 0, degenerateDropped: 2 });
  assert.throws(() => probeSummary(body.replace('12.5%', '12.6%'), optional, fixture), /percentage/);
  assert.throws(() => probeSummary(body.replace(/    - faceted-brep[^\n]*\n/, ''), optional, fixture));
  assert.throws(() => probeSummary(body + '  brep point-cache      0 hits / 0 misses (0.0% memoized)\n', optional, fixture));
});
test('#6537 decimal display intervals keep index truncation and frozen-byte size provenance', () => {
  const { fixture, result, text } = capture('house');
  // The actual captured scan is 1.84ms: 1.8 human display but 1ms percent
  // numerator. Truncating the displayed 1.8 or rounded JSON yields the same
  // here; the boundary input below makes lost JSON precision observable.
  probeSummary(text, result, fixture);
  const boundary = { ...result, indexBuildMs: 2.00 };
  const below = text.replace(/index-scan alone +1\.8 +6\.2%/, 'index-scan alone       2.0     6.2%');
  probeSummary(below, boundary, fixture); // raw 1.999ms -> JSON 2.00, trunc 1
  const above = below.replace('2.0     6.2%', '2.0    12.5%');
  probeSummary(above, boundary, fixture); // raw 2.001ms -> same JSON, trunc 2
  assert.throws(() => probeSummary(below.replace('6.2%', '18.8%'), boundary, fixture), /index display/);
  assert.throws(() => probeSummary(text, { ...result, indexBuildMs: 1.9 }, fixture), /index display/);
  assert.throws(() => probeSummary(text, { ...result, fileMb: result.fileMb + 0.001 }, fixture), /decimal provenance/);
  assert.throws(() => probeSummary(text.replace('2.4 MB', '2.5 MB'), result, fixture), /size display/);
  assert.throws(() => probeSummary(text, { ...result, fileMb: result.fileMb + 0.0001 }, fixture), /decimal provenance/);
});
test('#6537 refused summary retains only actual parsed provenance and cannot pass diagnostic comparison', () => {
  const { fixture, result, text } = capture('house');
  let receipt;
  assert.throws(() => probeSummary(text + '\nunexpected\n', result, fixture), error => {
    receipt = error.summaryReceipt;
    assert.equal(receipt.status, 'refused'); assert.ok(receipt.parsedLines > 10);
    assert.deepEqual(receipt.diagnostics, { csgFailures: 0, productsWithFailures: 0, degenerateDropped: 0 });
    return /extra diagnostics/.test(error.message);
  });
  const complete = probeSummary(text, result, fixture);
  assert.throws(() => requireSummaryDiagnostics(complete, receipt), /attribution differs/);
});
