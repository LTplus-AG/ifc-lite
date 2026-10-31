/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBrowserSession, assertCliRetained, assertMilestones, assertNativeSummary, assertViewerRetained } from './retained-qual-assert.mjs';

const SHA = 'a'.repeat(64);
const viewer = ({ state, ...over } = {}) => ({
  state: { error: null, models: 1, loadState: 'complete', meshCount: 7, summary: { kernel: 'retained', candidates: 10, started: true, published: 7,
    cancelled: 0, completeness: 'incomplete', failure: null, refused: [{}, {}, {}] }, ...state },
  requests: ['http://x/smlib/worker.mjs', 'http://x/retained-engine/pkg-retained/ifc-lite.js'], spans: ['load', 'geometry'],
  servedManifestSha256: SHA, expectedManifestSha256: SHA, ...over });

test('viewer: a retained load with published products passes, and a pinned count must match', () => {
  assertViewerRetained(viewer());
  assertViewerRetained(viewer({ expectation: { candidates: 10, published: 7 } }));
  assert.throws(() => assertViewerRetained(viewer({ expectation: { candidates: 10, published: 8 } })), /published 7 != pinned 8/);
});

test('viewer: an exact load (no retained summary) FAILS rather than being timed', () => {
  assert.throws(() => assertViewerRetained(viewer({ state: { summary: undefined } })), /store kernel=absent \(exact load\)/);
  assert.throws(() => assertViewerRetained(viewer({ state: { summary: null } })), /store kernel=absent/);
});

test('viewer: every evidence leg is required', () => {
  const cases = [[{ state: { error: 'boom' } }, /viewer error/], [{ state: { meshCount: 0 } }, /store meshes=0/], [{ state: { loadState: 'loading' } }, /loadState/],
    [{ requests: ['http://x/retained-engine/pkg-retained/a.js'] }, /no \/smlib\//], [{ requests: ['http://x/smlib/w.mjs'] }, /no \/retained-engine/],
    [{ spans: ['cache.lookup'] }, /cache.lookup/], [{ servedManifestSha256: 'b'.repeat(64) }, /served engine manifest/], [{ servedManifestSha256: null }, /served engine manifest/]];
  for (const [over, pattern] of cases) assert.throws(() => assertViewerRetained(viewer(over)), pattern);
  assert.throws(() => assertViewerRetained(viewer({ state: { summary: { kernel: 'retained', candidates: 10, started: true, published: 0, completeness: 'incomplete', failure: null, refused: new Array(10) } } })), /published=0/);
  assert.throws(() => assertViewerRetained(viewer({ state: { summary: { kernel: 'retained', candidates: 10, started: true, published: 7, completeness: 'complete', failure: null, refused: [] } } })), /!= candidates/);
  assert.throws(() => assertViewerRetained(viewer({ state: { summary: { kernel: 'retained', candidates: 10, started: true, published: 7, completeness: 'running', failure: null, refused: [{}, {}, {}] } } })), /completeness=running/);
});

const cli = (over = {}) => ({ exitCode: 0, stdout: '', stderr: 'Retained final: 7/10 products published; refusals {"a":3}; final\n',
  report: { format: 'ifc-lite.retained-report/1', settings: { kernel: 'retained' }, engine: { manifestSha256: SHA }, summary: { candidates: 10, published: 7, byCode: { a: 3 } } },
  objHead: '# ifc-lite OBJ export\n# units: metres\n# kernel: retained\n# retained final\n# final\n', expectedManifestSha256: SHA, ...over });

test('cli: report, stderr and OBJ header must agree', () => {
  assertCliRetained(cli());
  assertCliRetained(cli({ objHead: '# kernel: retained\n# retained shape-only: presentation obligations unmet: IfcAppearance\n# PresentationObligationsUnmet\n' }));
  assert.throws(() => assertCliRetained(cli({ exitCode: 1 })), /exit 1/);
  assert.throws(() => assertCliRetained(cli({ stdout: 'x' })), /stdout/);
  assert.throws(() => assertCliRetained(cli({ objHead: '# kernel: exact\n' })), /no retained kernel marker/);
  assert.throws(() => assertCliRetained(cli({ stderr: 'Retained final: 6/10 products published' })), /stderr summary/);
  assert.throws(() => assertCliRetained(cli({ report: { ...cli().report, engine: { manifestSha256: 'c'.repeat(64) } } })), /report engine/);
  assert.throws(() => assertCliRetained(cli({ report: { ...cli().report, settings: { kernel: 'exact' } } })), /report kernel/);
  assert.throws(() => assertCliRetained(cli({ report: { ...cli().report, summary: { candidates: 10, published: 0, byCode: { a: 10 } } } })), /published=0/);
  assert.throws(() => assertCliRetained(cli({ report: null })), /no report summary/);
});

test('native: the executable summary must be complete, violation-free and retained', () => {
  const summary = { schema: 'ifc-lite.native-retained-comparison/1', complete: true, violations: [], retained: { milliseconds: 1 }, candidates: 4, published: 3 };
  assertNativeSummary({ exitCode: 0, summary });
  assert.throws(() => assertNativeSummary({ exitCode: 1, summary }), /exit 1/);
  assert.throws(() => assertNativeSummary({ exitCode: 0, summary: { ...summary, complete: false } }), /complete=false/);
  assert.throws(() => assertNativeSummary({ exitCode: 0, summary: { ...summary, violations: ['x'] } }), /violations=1/);
  assert.throws(() => assertNativeSummary({ exitCode: 0, summary: { ...summary, retained: undefined } }), /retained timing/);
  assert.throws(() => assertNativeSummary({ exitCode: 0, summary: null }), /summary schema/);
  assert.throws(() => assertNativeSummary({ exitCode: 0, summary, expectation: { candidates: 4, published: 2 } }), /pinned/);
});

test('browser: page tally must match the session summary and the staged manifest', () => {
  const run = { started: true, errors: [], startCandidates: 4, tally: { published: 3, refused: 1, meshes: 9 }, summary: { candidates: 4, published: 3, refused: 1 } };
  assertBrowserSession({ run, expectedManifestSha256: SHA, servedManifestSha256: SHA });
  assert.throws(() => assertBrowserSession({ run: { ...run, tally: { published: 2, refused: 2, meshes: 9 } }, expectedManifestSha256: SHA, servedManifestSha256: SHA }), /event tally/);
  assert.throws(() => assertBrowserSession({ run: { ...run, summary: null }, expectedManifestSha256: SHA, servedManifestSha256: SHA }), /no session summary/);
  assert.throws(() => assertBrowserSession({ run: { ...run, errors: ['x'] }, expectedManifestSha256: SHA, servedManifestSha256: SHA }), /page errors/);
  assert.throws(() => assertBrowserSession({ run, expectedManifestSha256: SHA, servedManifestSha256: 'd'.repeat(64) }), /served manifest/);
});

test('milestones must be present and ordered; the settled frame is optional but ordered when present', () => {
  const m = { loadChangeMs: 1, firstProductMs: 5, sceneHeldMs: 9, firstRetainedFrameMs: 12, terminalMs: 11, settledFrameMs: 20 };
  assertMilestones(m);
  assertMilestones({ ...m, settledFrameMs: null });
  assert.throws(() => assertMilestones({ ...m, firstRetainedFrameMs: null }), /firstRetainedFrameMs missing/);
  assert.throws(() => assertMilestones({ ...m, firstRetainedFrameMs: 8 }), /frame precedes the scene/);
  assert.throws(() => assertMilestones({ ...m, firstProductMs: 0 }), /before the load began/);
  assert.throws(() => assertMilestones({ ...m, settledFrameMs: 10 }), /settled frame precedes/);
});

test('8413: native timing must contain a finite nonnegative numeric duration', () => {
  const summary = { schema: 'ifc-lite.native-retained-comparison/1', complete: true, violations: [], candidates: 4, published: 3 };
  for (const retained of [{}, { milliseconds: null }, { milliseconds: '12' }, { milliseconds: NaN },
    { milliseconds: Infinity }, { milliseconds: -Infinity }, { milliseconds: -1 }]) {
    assert.throws(() => assertNativeSummary({ exitCode: 0, summary: { ...summary, retained } }), /retained.*milliseconds/);
  }
  // Zero is a measured value at the clock's resolution, unlike an absent duration.
  for (const milliseconds of [0, 0.5, 10]) assertNativeSummary({ exitCode: 0, summary: { ...summary, retained: { milliseconds } } });
});
