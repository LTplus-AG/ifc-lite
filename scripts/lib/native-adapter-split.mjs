/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The split native-adapter lane, SHADOW PHASE. The serial `native-adapter`
 * job (53-76 min) stays the verdict. Beside it, six lane jobs run the same
 * steps in parallel and a strict judge requires every one of them; a report
 * job compares both layouts per lane. They run only when the repo variable
 * NATIVE_ADAPTER_SPLIT is `shadow`, and never on a merge-queue batch or a
 * bisect probe: neither reads them, and a probe's result is the aggregate of
 * every job it calls.
 *
 * This module is the single source of the split's shape: which jobs exist and
 * what they need, which monolith step each lane maps to, and splitProblems,
 * the audit check-native-adapter-triggers.mjs runs so every lane job keeps the
 * opt-in gate, its own concurrency group and the bisect checkout. Node
 * built-ins only (the guard runs before `pnpm install`).
 */

import { jobCondition } from './workflow-job-condition.mjs';
import { jobBlock, WORKFLOW } from './native-adapter-nightly.mjs';

/** Lane jobs and what each needs. W finishes long before N, so na-cli-parity waiting on it costs nothing. */
export const SPLIT_NEEDS = {
  'na-native': [],
  'na-emscripten': [],
  'na-wasm': [],
  'na-viewer': ['na-emscripten', 'na-wasm'],
  'na-browser': ['na-native', 'na-emscripten'],
  'na-cli-parity': ['na-native', 'na-emscripten', 'na-wasm', 'na-viewer'],
};
export const SPLIT_LANE_JOBS = Object.keys(SPLIT_NEEDS);
/** The strict judge. At the flip it takes the id `native-adapter` (the record and the bisect read that name). */
export const SPLIT_JUDGE = 'na-split-judge';
/** Report only: both layouts, per lane. Deleted at the flip. */
export const SPLIT_COMPARE = 'na-split-compare';
export const SPLIT_JOBS = [...SPLIT_LANE_JOBS, SPLIT_JUDGE, SPLIT_COMPARE];

/** The monolith's opt-in gate, whitespace collapsed (check-native-adapter-triggers.mjs holds its exact lines). */
export const OPT_IN_GATE = "(!inputs.bisect_sha || inputs.bisect_adapter) && ( inputs.batch == true || github.event_name != 'pull_request' || (contains(github.event.pull_request.labels.*.name, 'ci:native-adapter') && (github.event.action != 'labeled' || github.event.label.name == 'ci:native-adapter')))";
/** Shadow only: not on a batch, not on a bisect probe, and only when switched on. */
export const SHADOW_GATE = "inputs.batch != true && !inputs.bisect_sha && vars.NATIVE_ADAPTER_SPLIT == 'shadow'";

/**
 * Every judged lane: the monolith's step id (its "Require every independent
 * result" list) and the split's [job, step id] pairs. A lane is green only
 * when all its split steps are. FINISH_JOIN is new: the monolith runs it as a
 * hard step with no id, so its failure aborts every later lane there.
 */
export const LANES = [
  ['HALFSPACE_GENERATED', 'halfspace-generated', [['na-native', 'halfspace-generated']]],
  ['HALFSPACE_FETCH', 'halfspace-fetch', [['na-native', 'halfspace-fetch']]],
  ['M3_NATIVE', 'm3-native', [['na-native', 'm3-native']]],
  ['M3_BROWSER', 'm3-browser', [['na-browser', 'm3-browser']]],
  ['NATIVE_COMPARE', 'native-compare', [['na-native', 'native-compare']]],
  ['NATIVE_CTEST', 'native-ctest', [['na-native', 'native-ctest']]],
  ['NATIVE_CONSUMERS', 'native-consumers', [['na-native', 'native-consumers']]],
  ['WASM_CTEST', 'wasm-ctest', [['na-emscripten', 'wasm-ctest']]],
  ['BROWSER_WORKERS', 'browser-workers', [['na-emscripten', 'browser-workers']]],
  ['BROWSER_RUNTIME', 'browser-runtime', [['na-browser', 'browser-runtime']]],
  // retained-browser-contract.mjs reads rust/wasm-bindings/smlib/m11-i-native-instances.json, a native reference.
  ['BROWSER_API', 'browser-api', [['na-cli-parity', 'browser-api']]],
  ['GENERATED_TYPES', 'generated-types', [['na-wasm', 'generated-types']]],
  ['PACKAGE_BOUNDARY', 'package-boundary', [['na-wasm', 'package-boundary']]],
  ['RETAINED_CLIPPY', 'retained-clippy', [['na-wasm', 'retained-clippy']]],
  ['CLI_RETAINED', 'cli-retained', [['na-viewer', 'cli-retained'], ['na-cli-parity', 'cli-parity']]],
  ['VIEWER_RETAINED', 'viewer-retained', [['na-viewer', 'viewer-retained'], ['na-cli-parity', 'browser-parity']]],
  ['OPEN_TESSELLATION', 'open-tessellation', [['na-native', 'open-tessellation']]],
  ['FINISH_JOIN', null, [['na-native', 'finish-join']]],
].map(([lane, mono, split]) => ({ lane, mono, split }));

/** The judged step ids of one split job. */
export const jobLaneSteps = (job) => LANES.flatMap((l) => l.split.filter(([j]) => j === job).map(([, step]) => step));

/** Whether every one of `steps` (a `toJSON(steps)` object) has outcome success; `missing` lists the others. */
export function stepVerdict(steps, ids) {
  const missing = ids.filter((id) => steps?.[id]?.outcome !== 'success').map((id) => `${id}=${steps?.[id]?.outcome ?? 'absent'}`);
  return { ok: missing.length === 0, missing };
}

/** One lane's outcome across split jobs: success only if every mapped step succeeded. */
export function splitLaneOutcome(lane, stepsByJob) {
  const outcomes = lane.split.map(([job, step]) => stepsByJob[job]?.[step]?.outcome ?? 'absent');
  return outcomes.find((o) => o !== 'success') ?? 'success';
}

/**
 * The strict judge over `needs` (the `toJSON(needs)` object). Lane jobs are
 * job-level continue-on-error in the shadow phase, so a failed one may still
 * report result `success`; its own `verdict` output is what says it passed. A
 * skipped or cancelled job, an absent verdict and two different commits all fail.
 */
export function judge(needs) {
  const problems = [];
  const stepsByJob = {};
  const heads = new Set();
  for (const job of SPLIT_LANE_JOBS) {
    const n = needs?.[job];
    if (!n) { problems.push(`${job}: not in needs`); continue; }
    if (n.result !== 'success') problems.push(`${job}: result ${n.result}`);
    if (n.outputs?.verdict !== 'success') problems.push(`${job}: verdict ${n.outputs?.verdict || 'absent'}`);
    if (n.outputs?.head) heads.add(n.outputs.head); else problems.push(`${job}: no head commit`);
    try { stepsByJob[job] = JSON.parse(n.outputs?.steps || '{}'); } catch { problems.push(`${job}: unreadable steps output`); }
  }
  if (heads.size > 1) problems.push(`lane jobs ran different commits: ${[...heads].join(', ')}`);
  const lanes = LANES.map((lane) => ({ lane: lane.lane, outcome: splitLaneOutcome(lane, stepsByJob) }));
  for (const { lane, outcome } of lanes) if (outcome !== 'success') problems.push(`${lane}=${outcome}`);
  return { ok: problems.length === 0, problems, lanes };
}

const GROUP = (id) => `geometry-platform-${id}-\${{ !inputs.batch && github.event.pull_request.number || github.run_id }}`;
const CANCEL = "${{ github.event_name == 'pull_request' && !inputs.batch }}";
const steps = (block) => block.split(/^ {6}- /m).slice(1);
const has = (block, line) => block.split('\n').some((l) => l.trim() === line);
/** The setup-wasm-build inputs that pick the restored cache; shared-key defaults to main in the action. */
const CACHE_KEYS = ['cache-prefix', 'shared-key', 'pinned-rust-cache', 'cache-bin'];
const cacheInputs = (step) => ({ 'shared-key': 'main', ...Object.fromEntries([...step.matchAll(/^ {10}([\w-]+): (.+?)\s*$/gm)].map((m) => [m[1], m[2]])) });

/** Blocks of the jobs that run the lane's work: the monolith and, when present, every split job. */
export function laneJobBlocks(text) {
  return ['native-adapter', ...SPLIT_JOBS].map((id) => ({ id, block: jobBlock(text, id) })).filter((j) => j.block !== null);
}

/** The audit of the split jobs; an absent split (none of its jobs) is not a problem, a partial one is. */
export function splitProblems(text) {
  const present = SPLIT_JOBS.filter((id) => jobBlock(text, id) !== null);
  if (present.length === 0) return [];
  const out = [];
  const monoStep = steps(jobBlock(text, 'native-adapter') ?? '').find((t) => /uses: \.\/\.github\/actions\/setup-wasm-build/.test(t));
  const monoCache = monoStep ? cacheInputs(monoStep) : {};
  const missing = SPLIT_JOBS.filter((id) => !present.includes(id));
  if (missing.length > 0) return [`${WORKFLOW}: the native-adapter split is partial; missing job(s) ${missing.join(', ')} (scripts/lib/native-adapter-split.mjs)`];
  for (const id of SPLIT_JOBS) {
    const block = jobBlock(text, id);
    const needs = id === SPLIT_JUDGE ? SPLIT_LANE_JOBS : id === SPLIT_COMPARE ? ['native-adapter', ...SPLIT_LANE_JOBS, SPLIT_JUDGE] : SPLIT_NEEDS[id];
    // Downstream lane jobs and the report skip a superseded run's leftovers; the judge must still run and fail.
    const prefix = needs.length === 0 ? '' : id === SPLIT_JUDGE ? '!cancelled() && ' : "!cancelled() && !contains(needs.*.result, 'cancelled') && ";
    const expected = `${prefix}${OPT_IN_GATE} && ${SHADOW_GATE}`;
    let condition;
    try {
      condition = jobCondition(block, id)?.replace(/\s+/g, ' ') ?? null;
    } catch (err) {
      out.push(`${WORKFLOW}: ${err.message}`);
    }
    if (condition !== undefined && condition !== expected) out.push(`${WORKFLOW}: split job ${id} must be gated on exactly: ${expected}`);
    if (!block.includes(`\n    concurrency:\n      group: ${GROUP(id)}\n      cancel-in-progress: ${CANCEL}\n`)) {
      out.push(`${WORKFLOW}: split job ${id} needs its own job-level concurrency group ${GROUP(id)} (a shared group serialises or cancels sibling jobs) with cancel-in-progress only for labelled pull_request runs`);
    }
    const listed = block.match(/^ {4}needs: \[([^\]]*)\]\s*$/m)?.[1].split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    if (listed.length !== needs.length || needs.some((n) => !listed.includes(n))) out.push(`${WORKFLOW}: split job ${id} must need exactly [${needs.join(', ')}]`);
    if (/^ {4}name:/m.test(block)) out.push(`${WORKFLOW}: split job ${id} must not set name: (the judge becomes native-adapter, which the coverage record reads by id)`);
    if (!/^ {4}continue-on-error: true\s*$/m.test(block)) out.push(`${WORKFLOW}: split job ${id} must be job-level continue-on-error while the monolith is the verdict (shadow phase)`);
    const budget = block.match(/^ {4}timeout-minutes: (\d+)\s*$/m);
    if (!budget || Number(budget[1]) > 90) out.push(`${WORKFLOW}: split job ${id} needs a literal timeout-minutes of at most 90`);
    const own = steps(block).filter((s) => /\buses: actions\/checkout@/.test(s) && !/^\s*repository:/m.test(s));
    if (own.length === 0 || own.some((s) => !has(s, 'ref: ${{ inputs.bisect_sha }}'))) out.push(`${WORKFLOW}: every checkout of this repository in split job ${id} must use ref: \${{ inputs.bisect_sha }} (a bisect probe tests that commit)`);
    for (const s of steps(block).filter((t) => /\buses: actions\/upload-artifact@/.test(t))) {
      const name = s.match(/^\s*name: (\S+)\s*$/m)?.[1] ?? '';
      if (!name.startsWith('na-') || !has(s, 'overwrite: true')) out.push(`${WORKFLOW}: split job ${id} uploads '${name}'; split artifacts are named na-* (test.yml shares the run's artifact namespace) and set overwrite: true (a re-run replaces them)`);
    }
    for (const s of steps(block).filter((t) => /uses: \.\/\.github\/actions\/setup-wasm-build/.test(t))) {
      const inputs = cacheInputs(s);
      if (inputs['save-if'] !== "'false'") out.push(`${WORKFLOW}: split job ${id} must restore its Rust cache only (setup-wasm-build save-if: 'false'): the shadow phase writes no cache`);
      if (CACHE_KEYS.some((k) => inputs[k] !== monoCache[k])) out.push(`${WORKFLOW}: split job ${id} must restore the single job's Rust cache (setup-wasm-build ${CACHE_KEYS.map((k) => `${k}: ${monoCache[k] ?? '(default)'}`).join(', ')}), so both layouts start alike`);
    }
    if (SPLIT_LANE_JOBS.includes(id)) {
      for (const step of jobLaneSteps(id)) {
        const s = steps(block).find((t) => has(t, `id: ${step}`));
        if (!s || !has(s, 'continue-on-error: true')) out.push(`${WORKFLOW}: split job ${id} must run lane step ${step} with continue-on-error (it is judged, not fatal)`);
      }
      const verdict = steps(block).find((t) => has(t, 'id: verdict'));
      if (!verdict || !has(verdict, 'if: always()') || !verdict.includes(`node scripts/native-adapter-split.mjs verdict --job ${id}`) || !has(block, 'verdict: ${{ steps.verdict.outputs.verdict }}')) {
        out.push(`${WORKFLOW}: split job ${id} must end with an if: always() step id verdict running scripts/native-adapter-split.mjs verdict --job ${id}, published as the job output verdict`);
      }
    }
  }
  // A named list dropped pkg-diff, which the viewer build imports (the first dispatched shadow run).
  const wasmUpload = steps(jobBlock(text, 'na-wasm')).find((t) => has(t, 'name: na-split-wasm-pkg'));
  if (!wasmUpload || !has(wasmUpload, 'path: packages/wasm/pkg*') || !has(wasmUpload, 'include-hidden-files: true')) out.push(`${WORKFLOW}: na-wasm must hand over every bundle build-wasm.sh writes (path: packages/wasm/pkg*, include-hidden-files: true) as na-split-wasm-pkg`);
  if (!jobBlock(text, SPLIT_JUDGE).includes('node scripts/native-adapter-split.mjs judge')) out.push(`${WORKFLOW}: ${SPLIT_JUDGE} must run scripts/native-adapter-split.mjs judge (success only if every lane job succeeded, skipped included)`);
  if (!jobBlock(text, SPLIT_COMPARE).includes('node scripts/native-adapter-split.mjs compare')) out.push(`${WORKFLOW}: ${SPLIT_COMPARE} must run scripts/native-adapter-split.mjs compare`);
  // The mapping must name exactly the monolith's judged lanes, or the comparison silently drops one.
  const list = (jobBlock(text, 'native-adapter') ?? '').match(/for lane in ([A-Z0-9_ ]+); do/)?.[1].trim().split(/\s+/) ?? [];
  const mapped = LANES.filter((l) => l.mono !== null).map((l) => l.lane);
  if (list.length !== mapped.length || mapped.some((l) => !list.includes(l))) out.push(`${WORKFLOW}: LANES in scripts/lib/native-adapter-split.mjs must map exactly the monolith's judged lanes (${list.join(' ')})`);
  return out;
}
