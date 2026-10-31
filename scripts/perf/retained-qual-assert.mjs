/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// "Fail, not skip, if the retained engine isn't really used" (#7955 PR 3).
// Every runner calls one of these on every sample and records a failure row when it
// throws; there is no path that times an exact-kernel load as a retained sample.
// `expectation` is an optional pinned {candidates, published} from a prior correctness
// run; without a pin the sample must still publish and be self-consistent.

function check(problems, ok, message) { if (!ok) problems.push(message); }
function finish(problems, what) {
  if (problems.length) throw new Error(`${what}: retained engine not demonstrably used: ${problems.join('; ')}`);
}
const isCount = value => Number.isInteger(value) && value >= 0;

function counts(problems, summary, expectation) {
  check(problems, isCount(summary.candidates) && summary.candidates > 0, `candidates=${summary.candidates}`);
  check(problems, isCount(summary.published) && summary.published > 0, `published=${summary.published}`);
  if (expectation) {
    check(problems, summary.candidates === expectation.candidates, `candidates ${summary.candidates} != pinned ${expectation.candidates}`);
    check(problems, summary.published === expectation.published, `published ${summary.published} != pinned ${expectation.published}`);
  }
}

/** The viewer store's published count and kernel, plus the network and trace evidence. */
export function assertViewerRetained({ state, requests, spans, servedManifestSha256, expectedManifestSha256, expectation }) {
  const problems = [], summary = state?.summary;
  check(problems, state && state.error === null, `viewer error ${JSON.stringify(state?.error)}`);
  check(problems, state?.models === 1, `models=${state?.models}`);
  check(problems, summary?.kernel === 'retained', `store kernel=${summary?.kernel ?? 'absent (exact load)'}`);
  if (summary) {
    check(problems, summary.failure === undefined || summary.failure === null, `model failure: ${summary.failure}`);
    check(problems, summary.started !== false, 'engine never started');
    check(problems, summary.completeness === 'complete' || summary.completeness === 'incomplete', `completeness=${summary.completeness}`);
    counts(problems, summary, expectation);
    check(problems, summary.published + summary.refused.length === summary.candidates,
      `published ${summary.published} + unpublished ${summary.refused.length} != candidates ${summary.candidates}`);
    check(problems, state.meshCount > 0, `store meshes=${state.meshCount}`);
  }
  check(problems, state?.loadState === 'complete', `loadState=${state?.loadState}`);
  check(problems, requests.some(url => url.includes('/smlib/')), 'no /smlib/ request');
  check(problems, requests.some(url => url.includes('/retained-engine/pkg-retained/')), 'no /retained-engine/pkg-retained/ request');
  check(problems, !spans?.includes('cache.lookup'), 'exact-path cache.lookup span present');
  check(problems, /^[a-f0-9]{64}$/.test(servedManifestSha256 ?? '') && servedManifestSha256 === expectedManifestSha256,
    `served engine manifest ${servedManifestSha256} != staged ${expectedManifestSha256}`);
  finish(problems, 'viewer');
}

/** The built Node CLI's report and OBJ for one `export --kernel retained` process. */
export function assertCliRetained({ exitCode, stdout, stderr, report, objHead, expectedManifestSha256, expectation }) {
  const problems = [];
  check(problems, exitCode === 0, `exit ${exitCode}: ${String(stderr).slice(0, 300)}`);
  check(problems, stdout === '', 'file export leaked onto stdout');
  check(problems, report?.format === 'ifc-lite.retained-report/1', `report format ${report?.format}`);
  check(problems, report?.settings?.kernel === 'retained', `report kernel ${report?.settings?.kernel}`);
  check(problems, report?.engine?.manifestSha256 === expectedManifestSha256,
    `report engine ${report?.engine?.manifestSha256} != staged ${expectedManifestSha256}`);
  const summary = report?.summary;
  if (summary) {
    counts(problems, summary, expectation);
    const refused = Object.values(summary.byCode ?? {}).reduce((sum, n) => sum + n, 0);
    check(problems, summary.published + refused === summary.candidates, `published ${summary.published} + refused ${refused} != candidates ${summary.candidates}`);
    const line = String(stderr).match(/Retained (?:final|shape-only): (\d+)\/(\d+) products published/);
    check(problems, line && Number(line[1]) === summary.published && Number(line[2]) === summary.candidates, 'stderr summary does not match the report');
  } else problems.push('no report summary');
  // The writer emits the kernel and marker lines first; callers pass only the head of the OBJ.
  check(problems, /^# kernel: retained\n(?:# retained final\n# final\n|# retained shape-only: [^\n]*\n# PresentationObligationsUnmet\n)/m.test(String(objHead)),
    'OBJ header has no retained kernel marker');
  finish(problems, 'cli');
}

/** The native executable's own summary.json (`retained_compare --out DIR`). */
export function assertNativeSummary({ exitCode, summary, expectation }) {
  const problems = [];
  check(problems, exitCode === 0, `exit ${exitCode}`);
  check(problems, summary?.schema === 'ifc-lite.native-retained-comparison/1', `summary schema ${summary?.schema}`);
  check(problems, summary?.complete === true, `complete=${summary?.complete}`);
  check(problems, Array.isArray(summary?.violations) && summary.violations.length === 0, `violations=${summary?.violations?.length}`);
  check(problems, summary?.retained && typeof summary.retained === 'object', 'no retained timing block');
  const milliseconds = summary?.retained?.milliseconds;
  check(problems, Number.isFinite(milliseconds) && milliseconds >= 0, 'retained.milliseconds must be a finite nonnegative number');
  const mismatch = summary?.universeMismatch;
  check(problems, mismatch === undefined || mismatch === false || (Array.isArray(mismatch) && mismatch.length === 0), `universeMismatch=${JSON.stringify(mismatch)}`);
  const skipped = summary?.skipped;
  check(problems, skipped === undefined || skipped === 0 || (Array.isArray(skipped) && skipped.length === 0), `skipped=${JSON.stringify(skipped)}`);
  if (summary) counts(problems, summary, expectation);
  finish(problems, 'native');
}

/** One fresh-page retained browser session (`RetainedModelSession.run`), page tally cross-checked with its summary. */
export function assertBrowserSession({ run, expectedManifestSha256, servedManifestSha256, expectation }) {
  const problems = [], summary = run?.summary;
  check(problems, run?.started === true, 'session never started');
  check(problems, run?.errors?.length === 0, `page errors ${JSON.stringify(run?.errors)}`);
  if (summary) {
    counts(problems, summary, expectation);
    check(problems, summary.published + summary.refused === summary.candidates, `published ${summary.published} + refused ${summary.refused} != candidates ${summary.candidates}`);
    check(problems, run.startCandidates === summary.candidates, `start event planned ${run.startCandidates}, summary ${summary.candidates}`);
    check(problems, run.tally.published === summary.published && run.tally.refused === summary.refused, `event tally ${JSON.stringify(run.tally)} != summary`);
    check(problems, run.tally.meshes > 0, 'no meshes in any published product');
  } else problems.push('no session summary');
  check(problems, servedManifestSha256 === expectedManifestSha256, `served manifest ${servedManifestSha256} != staged ${expectedManifestSha256}`);
  finish(problems, 'browser');
}

/** Milestones must be present and ordered, or the "first retained frame" is not what it claims. */
export function assertMilestones(m) {
  const problems = [];
  // settledFrameMs is optional: an on-demand renderer may draw nothing after the terminal state.
  const names = ['loadChangeMs', 'firstProductMs', 'sceneHeldMs', 'firstRetainedFrameMs', 'terminalMs'];
  for (const name of names) check(problems, Number.isFinite(m?.[name]), `${name} missing`);
  if (!problems.length) {
    check(problems, m.loadChangeMs <= m.firstProductMs, 'a product before the load began');
    check(problems, m.firstProductMs <= m.sceneHeldMs, 'scene held geometry before the store published it');
    check(problems, m.sceneHeldMs <= m.firstRetainedFrameMs, 'frame precedes the scene holding retained geometry');
    check(problems, m.firstProductMs <= m.terminalMs, 'terminal before the first product');
    if (m.settledFrameMs !== null && m.settledFrameMs !== undefined) {
      check(problems, Math.max(m.terminalMs, m.firstRetainedFrameMs) <= m.settledFrameMs, 'settled frame precedes terminal/first frame');
    }
  }
  finish(problems, 'viewer milestones');
}
