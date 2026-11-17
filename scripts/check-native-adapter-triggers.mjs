#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: the SMLib `native-adapter` lane triggers on everything the retained
 * engine compiles from, and keeps its cost controls (#7955, #8460).
 *
 * The lane (`.github/workflows/geometry-platform.yml`) qualifies retained
 * parity. It holds a hosted runner for about an hour, so it does NOT run on
 * every push or PR: nightly (main's guard, with the corpus), on demand, and on
 * a PR only with the `ci:native-adapter` label. A hand-maintained exact-path
 * filter missed shared code the retained engine consumes
 * (`rust/geometry/src/processors`, `rust/core`, `rust/processing/src/style`),
 * so a labelled PR could pass without observing a change that breaks retained
 * parity. This derives the required crate directories from the Cargo manifests
 * -- the transitive path-dependency closure (normal, dev and build
 * dependencies) of the lane's root crates -- and fails when:
 *
 *   - a crate directory in that closure, a non-crate Rust input, or a local
 *     action the job calls is not covered by `on.pull_request.paths`;
 *   - the workflow triggers on push, has no nightly `schedule`, or loses the
 *     opt-in label `if`, the `labeled` type or the job-level per-PR concurrency;
 *   - the corpus is not its own scheduled/dispatch-only, sharded, bounded,
 *     judged job with a required aggregate, or the nightly failure reporter
 *     does not cover it.
 *
 * Manifests are parsed by hand, so a shape this parser cannot read throws
 * (`[dependencies.foo]` sub-tables, multi-line inline tables) rather than
 * silently shrinking the closure.
 *
 * MERGE-QUEUE BATCHES. Nothing above ran the lane on a batch, so #8408 and
 * #8415 merged untested retained failures. test.yml's `changes` job runs
 * `--batch-decide`, which writes `native_adapter=true|false` to
 * $GITHUB_OUTPUT, and its `native-adapter` job calls this workflow with
 * `batch: true` unless the answer is exactly `false`. Which paths count, and
 * every way the decision fails closed, are in scripts/lib/native-adapter-batch.mjs.
 * The audit holds the lists against `on.pull_request.paths` and the wiring in test.yml.
 *
 * `--root <dir>` points it at a mutated copy of the tree (see the test).
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesAny } from './lib/ci-path-coverage.mjs';
import { permissionBlocks, workflowAsks } from './lib/workflow-permissions.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { BATCH_EXCLUDE, BATCH_KEEP, batchGlobs, decideBatch, scriptImports } from './lib/native-adapter-batch.mjs';

const WORKFLOW = '.github/workflows/geometry-platform.yml';
const TEST_WORKFLOW = '.github/workflows/test.yml';
/** Crates the lane builds or drives: the native consumer and the browser worker's wasm crate. */
export const ROOT_CRATES = ['rust/retained-native', 'rust/wasm-bindings'];
/** Non-crate inputs every Rust build of the lane reads. */
export const EXTRA_GLOBS = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo/**'];

const SELF = 'scripts/check-native-adapter-triggers.mjs';
const DEP_SECTION = /^\[(?:target\.[^\]]+\.)?(?:dev-|build-)?dependencies\]$/;

/** Path deps of one manifest as repo-relative crate dirs. Workspace-inherited deps resolve through `workspace`. */
export function pathDeps(manifestText, crateDir, workspace) {
  const found = new Set();
  let section = '';
  for (const raw of manifestText.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '') continue;
    const header = line.match(/^\[.*\]$/);
    if (header) {
      if (/^\[(?:target\.[^\]]+\.)?(?:workspace\.|dev-|build-)?dependencies\.[^\]]+\]$/.test(line)) {
        throw new Error(`${crateDir}/Cargo.toml: dependency sub-table ${line} is not parsed; write it as an inline table`);
      }
      section = line;
      continue;
    }
    const isDep = DEP_SECTION.test(section) || section === '[workspace.dependencies]';
    if (isDep) {
      const dotted = line.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*=/);
      if (dotted && dotted[2] !== 'workspace') throw new Error(`${crateDir}/Cargo.toml: dotted key ${dotted[1]}.${dotted[2]} is not parsed; write ${dotted[1]} as an inline table`);
    }
    const named = line.match(/^([A-Za-z0-9_-]+)(?:\.workspace\s*=\s*true|\s*=\s*(.*))/);
    if (!isDep || !named) continue;
    const spec = named[2] ?? '';
    if (spec.trim().startsWith('{') && !spec.includes('}')) {
      throw new Error(`${crateDir}/Cargo.toml: multi-line inline table for ${named[1]} is not parsed; keep it on one line`);
    }
    const path = spec.match(/\bpath\s*=\s*["']([^"']+)["']/);
    if (path) found.add(posix.normalize(posix.join(crateDir, path[1])));
    else if (section !== '[workspace.dependencies]' && (named[2] === undefined || /\bworkspace\s*=\s*true/.test(spec))) {
      const via = workspace.get(named[1]);
      if (via) found.add(via);
    }
  }
  return found;
}

export function workspaceDeps(rootManifestText) {
  const map = new Map();
  let inSection = false;
  for (const raw of rootManifestText.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (/^\[.*\]$/.test(line)) {
      if (/^\[workspace\.dependencies\.[^\]]+\]$/.test(line)) {
        throw new Error(`Cargo.toml: ${line} is not parsed; write it as an inline table under [workspace.dependencies]`);
      }
      inSection = line === '[workspace.dependencies]';
      continue;
    }
    const dotted = inSection && line.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*=/);
    if (dotted) throw new Error(`Cargo.toml: dotted key ${dotted[1]}.${dotted[2]} under [workspace.dependencies] is not parsed; write ${dotted[1]} as an inline table`);
    const open = inSection && line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{(?!.*\})/);
    if (open) throw new Error(`Cargo.toml: multi-line inline table for workspace dependency ${open[1]} is not parsed; keep it on one line`);
    const m = inSection && line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{.*\bpath\s*=\s*["']([^"']+)["']/);
    if (m) map.set(m[1], posix.normalize(m[2]));
  }
  return map;
}

/** Transitive crate-directory closure of `roots`. */
export function crateClosure(root, roots = ROOT_CRATES) {
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const workspace = workspaceDeps(read('Cargo.toml'));
  const seen = new Set();
  const visit = (dir) => {
    if (seen.has(dir)) return;
    const manifest = `${dir}/Cargo.toml`;
    if (!existsSync(join(root, manifest))) throw new Error(`${manifest} does not exist (path dependency of the native-adapter closure)`);
    seen.add(dir);
    for (const dep of pathDeps(read(manifest), dir, workspace)) visit(dep);
  };
  for (const r of roots) visit(r);
  return [...seen].sort();
}

/** `on.<event>.paths` block list, or null when the event or list is absent. */
export function eventPaths(text, event) {
  const lines = text.split('\n');
  const onAt = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onAt === -1) return null;
  let inEvent = false;
  let inPaths = false;
  let paths = null;
  for (let i = onAt + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^\S/.test(raw)) break;
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    if (/^ {2}\S/.test(raw)) { inEvent = raw.startsWith(`  ${event}:`); inPaths = false; continue; }
    if (!inEvent) continue;
    if (/^ {4}paths:\s*$/.test(raw)) { inPaths = true; paths = []; continue; }
    if (/^ {4}\S/.test(raw)) { inPaths = false; continue; }
    if (inPaths) {
      const m = raw.trim().match(/^-\s*'([^']+)'$/);
      if (!m) throw new Error(`unparseable on.${event}.paths entry ${JSON.stringify(raw.trim())}`);
      paths.push(m[1]);
    }
  }
  return paths;
}

const CORPUS_IF = "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.corpus == true)";

/** Text of one top-level job (from `  id:` to the next two-space key). */
export function jobBlock(text, id) {
  const m = text.match(new RegExp(`^ {2}${id}:\\n([\\s\\S]*?)(?=^ {2}[A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, 'm'));
  return m ? m[1] : null;
}

/** The downloaded corpus lives in its own scheduled/dispatch job, sharded, with a required aggregate. */
export function corpusJobProblems(text) {
  const out = [];
  const corpus = jobBlock(text, 'native-corpus');
  const result = jobBlock(text, 'native-corpus-result');
  const main = jobBlock(text, 'native-adapter');
  if (corpus === null) return [`${WORKFLOW}: no native-corpus job; the nightly corpus must not run inside native-adapter`];
  if (result === null) out.push(`${WORKFLOW}: no native-corpus-result aggregate job over the shards`);
  if (main !== null && /--manifest tests\/models\/manifest/.test(main)) out.push(`${WORKFLOW}: native-adapter runs the corpus itself; it belongs in the native-corpus job`);
  if (new RegExp(`^ {4}if: ${CORPUS_IF.replace(/[().|=&']/g, '\\$&')}\\s*$`, 'm').test(corpus) === false) out.push(`${WORKFLOW}: native-corpus must be gated on exactly: ${CORPUS_IF}`);
  const budget = corpus.match(/^ {4}timeout-minutes: (\d+)\s*$/m);
  if (!budget || Number(budget[1]) > 360) out.push(`${WORKFLOW}: native-corpus needs a literal timeout-minutes within GitHub's 360-minute limit`);
  if (!/^ {6}fail-fast: false\s*$/m.test(corpus)) out.push(`${WORKFLOW}: native-corpus matrix must set fail-fast: false so one slow shard does not hide the others`);
  const matrix = corpus.match(/^ {8}shard: \[([0-9, ]+)\]\s*$/m);
  const shards = matrix ? matrix[1].split(',').map((s) => Number(s.trim())) : [];
  if (shards.length === 0 || shards.some((s, i) => s !== i)) out.push(`${WORKFLOW}: native-corpus matrix shard must list 0..N-1 in order`);
  const select = corpus.match(/corpus-shards\.mjs shard [^\n]*--shards (\d+)/);
  if (shards.length > 0 && (!select || Number(select[1]) !== shards.length)) out.push(`${WORKFLOW}: the shard selection step's --shards must equal the matrix size (${shards.length})`);
  const compare = corpus.match(/id: compare\n([\s\S]*?)\n {6}(?:# |- )/);
  if (!compare || !/^ {8}continue-on-error: true[ \t]*$/m.test(compare[1]) || !/^ {8}timeout-minutes: \d+[ \t]*$/m.test(compare[1])) {
    out.push(`${WORKFLOW}: the corpus comparison step needs continue-on-error and its own timeout-minutes so a timeout is judged, not fatal`);
  }
  // `(?!^ {6}- )` stops the lazy match at the next step, so an earlier step's `if: always()` cannot satisfy it.
  if (!/^ {8}if: always\(\)\s*\n(?:(?!^ {6}- )[\s\S])*?check-retained-corpus-summary\.mjs --report-violations "\$RUNNER_TEMP\/native-corpus\/summary\.json"/m.test(corpus)) {
    out.push(`${WORKFLOW}: every shard must judge its summary.json in an if: always() step`);
  }
  if (result !== null) {
    if (!/^ {4}needs: \[native-corpus\]\s*$/m.test(result)) out.push(`${WORKFLOW}: native-corpus-result must need native-corpus`);
    if (!/^ {4}if: always\(\) && /m.test(result)) out.push(`${WORKFLOW}: native-corpus-result must run if: always() so a failed shard still reports`);
    const agg = result.match(/check-retained-corpus-summary\.mjs --shards (\d+) --report-violations /);
    if (shards.length > 0 && (!agg || Number(agg[1]) !== shards.length)) out.push(`${WORKFLOW}: native-corpus-result must require exactly the matrix's ${shards.length} shard summaries`);
    if (shards.length > 0 && !new RegExp(`corpus-shards\\.mjs merge --shards ${shards.length} `).test(result)) out.push(`${WORKFLOW}: the product-table merge must pass --shards ${shards.length} so a shard without products.tsv cannot merge away`);
    if (!/^ {8}if: always\(\)\s*\n {8}run: node scripts\/retained-compare\/corpus-shards\.mjs excluded --manifest tests\/models\/manifest\.json\s*$/m.test(result)) {
      out.push(`${WORKFLOW}: native-corpus-result must report the models excluded from the corpus (corpus-shards.mjs excluded, if: always()) so an unchecked model is never read as covered`);
    }
    if (!/\[\[ "\$SHARDS_RESULT" == success \]\]/.test(result)) out.push(`${WORKFLOW}: native-corpus-result must fail when the matrix result is not success`);
  }
  const reporter = jobBlock(text, 'report-scheduled-failure');
  if (reporter !== null && !/^ {4}needs: \[native-adapter, native-corpus-result\]\s*$/m.test(reporter)) out.push(`${WORKFLOW}: report-scheduled-failure must need native-corpus-result so a corpus failure is reported`);
  const browser = jobBlock(text, 'browser-corpus');
  if (browser === null || !/^ {4}continue-on-error: true\s*$/m.test(browser)) out.push(`${WORKFLOW}: browser-corpus must exist and stay report-only (job-level continue-on-error)`);
  return out;
}

/** A path inside `glob`, to test coverage with a matcher. */
const probe = (glob) => glob.replaceAll('**', 'x/x').replaceAll('*', 'x');

/**
 * Whether `globs` cover `glob`. A literal path: any matching entry. `<dir>/**`: only `**` or a literal `<base>/**` with `<dir>` at or under `<base>`,
 * so `rust/geometry/x/x` does not cover `rust/geometry/**`. Any other wildcard: the identical entry. Conservative: an entry with a wildcard before `/**` covers nothing.
 */
function coversAll(glob, globs) {
  if (!glob.endsWith('/**')) return /[*?]/.test(glob) ? globs.includes(glob) : matchesAny(glob, globs);
  const dir = glob.slice(0, -3);
  return globs.some((g) => {
    if (!g.endsWith('/**')) return g === '**';
    const base = g.slice(0, -3);
    return !/[*?]/.test(base) && (dir === base || dir.startsWith(`${base}/`));
  });
}

/** Crates a merge-queue batch must always run on. */
const ENGINE_CRATES = [...ROOT_CRATES, 'rust/geometry', 'rust/geometry-runtime'];

/** `exclude` and `keep` stand in for BATCH_EXCLUDE and BATCH_KEEP (see the test). */
export function audit(root, exclude = BATCH_EXCLUDE, keep = BATCH_KEEP) {
  const failures = [];
  const wfPath = join(root, WORKFLOW);
  if (!existsSync(wfPath)) return [`${WORKFLOW} is missing`];
  const text = readFileSync(wfPath, 'utf8');

  let pr;
  try {
    pr = eventPaths(text, 'pull_request');
  } catch (err) {
    return [`${WORKFLOW}: ${err.message}`];
  }
  if (!pr || pr.length === 0) failures.push(`${WORKFLOW}: on.pull_request.paths is missing`);
  // #8460: the lane is too costly per push; nightly is main's guard, labelled PRs are the opt-in.
  if (/^ {2}push:/m.test(text.slice(0, text.indexOf('\njobs:')))) failures.push(`${WORKFLOW}: must not trigger on push; the nightly schedule guards main (#8460)`);
  if (!/^ {2}schedule:\s*\n\s+- cron: '/m.test(text)) failures.push(`${WORKFLOW}: on.schedule (the nightly guard for main, with the corpus) is missing`);

  // The opt-in label gate must not silently vanish (it would put the lane back on every PR).
  const mainJob = jobBlock(text, 'native-adapter') ?? '';
  if (!/^ {4}if: >-\s*\n\s+inputs\.batch == true \|\|\s*\n\s+github\.event_name != 'pull_request' \|\|\s*\n\s+\(contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci:native-adapter'\) &&\s*\n\s+\(github\.event\.action != 'labeled' \|\| github\.event\.label\.name == 'ci:native-adapter'\)\)\s*$/m.test(mainJob)) {
    failures.push(`${WORKFLOW}: the native-adapter job must keep its opt-in gate: a merge-queue batch call and non-PR events run, a PR only with the ci:native-adapter label (and only that label's event restarts it)`);
  }
  if (!/^ {4}types: \[[^\]]*\blabeled\b[^\]]*\]\s*$/m.test(text.slice(text.indexOf('  pull_request:'), text.indexOf('  schedule:')))) {
    failures.push(`${WORKFLOW}: on.pull_request.types must include labeled so applying the label starts the job`);
  }
  // Job level (#8460): a workflow-level group lets a skipped run cancel the running qualification.
  if (/^concurrency:/m.test(text)) failures.push(`${WORKFLOW}: concurrency must be set on the native-adapter job, not the workflow (a skipped run would cancel a running one)`);
  if (!/^ {4}concurrency:\s*\n {6}group: geometry-platform-\$\{\{ !inputs\.batch && github\.event\.pull_request\.number \|\| github\.run_id \}\}\s*\n {6}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' && !inputs\.batch \}\}\s*$/m.test(mainJob)) {
    failures.push(`${WORKFLOW}: the native-adapter job's concurrency must be per-PR with cancel-in-progress only for labelled pull_request runs; nightly, manual and merge-queue batch runs are never cancelled`);
  }
  failures.push(...batchWiringProblems(text, root));

  let closure;
  try {
    closure = crateClosure(root);
  } catch (err) {
    return [...failures, `${err.message}`];
  }
  if (pr) {
    for (const dir of closure) {
      // The literal directory glob, not probe files: `<dir>/Cargo.toml` + `<dir>/src/lib.rs` entries would
      // satisfy probes and still leave the rest of the crate unable to trigger the lane.
      if (!pr.includes(`${dir}/**`)) {
        failures.push(`${WORKFLOW}: crate ${dir} (in the retained engine's dependency closure) is not covered by on.pull_request.paths -- add '${dir}/**'`);
      }
    }
    for (const extra of EXTRA_GLOBS) {
      if (!coversAll(extra, pr)) failures.push(`${WORKFLOW}: ${extra} is not covered by on.pull_request.paths`);
    }
    for (const glob of exclude) {
      if (!pr.includes(glob)) failures.push(`${WORKFLOW}: BATCH_EXCLUDE entry '${glob}' is not in on.pull_request.paths; drop it from scripts/lib/native-adapter-batch.mjs`);
    }
    // A keep glob outside the list would make a batch run on a path no labelled PR can.
    for (const glob of keep) {
      if (!matchesAny(probe(glob), pr)) failures.push(`${WORKFLOW}: BATCH_KEEP entry '${glob}' is not under on.pull_request.paths`);
    }
    const actions = new Set([...text.matchAll(/^\s*(?:-\s*)?uses:\s*\.\/(\.github\/actions\/[^/\s]+)/gm)].map((m) => m[1]));
    for (const action of actions) {
      if (!pr.includes(`${action}/**`)) failures.push(`${WORKFLOW}: local action ${action} is called by the job but not covered by on.pull_request.paths -- add '${action}/**'`);
    }
    // The engine core a batch must never skip: the engine crates, the native adapter, the Rust build inputs and the local actions.
    const batch = batchGlobs(pr, exclude, keep);
    for (const glob of [...ENGINE_CRATES.map((dir) => `${dir}/**`), 'native/**', ...EXTRA_GLOBS, ...[...actions].map((a) => `${a}/**`)]) {
      if (!coversAll(glob, batch)) failures.push(`${WORKFLOW}: BATCH_EXCLUDE drops ${glob}, which a merge-queue batch must always run on`);
    }
    // Every .mjs the lane runs with `node [--flags]`, and its scripts/ imports, must be able to trigger it, on a batch too.
    for (const script of scriptImports(root, [...text.matchAll(/\bnode (?:--[\w-]+(?:=\S+)? )*([\w./-]+\.mjs)\b/g)].map((m) => m[1]))) {
      if (!matchesAny(script, pr)) failures.push(`${WORKFLOW}: ${script} is run by (or imported by a script run by) the job but is not covered by on.pull_request.paths`);
      else if (!matchesAny(script, batch)) failures.push(`${WORKFLOW}: ${script} is run by (or imported by a script run by) the job but BATCH_EXCLUDE drops it from merge-queue batches`);
    }
  }
  const browser = jobBlock(text, 'browser-corpus');
  if (browser !== null && !/pnpm fixtures[\s\S]*browser\.mjs/.test(browser)) failures.push(`${WORKFLOW}: browser-corpus must download the corpus (pnpm fixtures) before comparing; the checkout does not hold the models`);
  failures.push(...corpusJobProblems(text));
  if (!/^ {2}report-scheduled-failure:/m.test(text)) failures.push(`${WORKFLOW}: no report-scheduled-failure job for a failing nightly run`);
  return failures;
}

// The test.yml lines that carry a batch's verdict into the required aggregate.
const BATCH_CALL_IF = "needs.changes.outputs.batch == 'true' && needs.changes.outputs.noop != 'true' && needs.changes.outputs.native_adapter != 'false'";
const BATCH_DECIDE_RUN = `node ${SELF} --batch-decide`;

/**
 * The merge-queue route: geometry-platform.yml is callable with a `batch`
 * input and no `corpus` one, and test.yml decides, calls and judges it.
 */
function batchWiringProblems(text, root) {
  const out = [];
  const onBlock = text.slice(0, text.indexOf('\njobs:'));
  const call = onBlock.match(/^ {2}workflow_call:\n((?: {4,}.*\n|\s*#.*\n)*)/m);
  if (!call || !/^ {6}batch:\n {8}type: boolean\n {8}default: false\n/m.test(call[1])) {
    out.push(`${WORKFLOW}: on.workflow_call must declare a boolean \`batch\` input (default false) for test.yml's merge-queue batch call`);
  } else if (/^ {6}corpus:/m.test(call[1])) {
    out.push(`${WORKFLOW}: on.workflow_call must not accept \`corpus\`; the corpus stays nightly and dispatch only`);
  }
  const testPath = join(root, TEST_WORKFLOW);
  if (!existsSync(testPath)) return [...out, `${TEST_WORKFLOW} is missing; merge-queue batches cannot run the native adapter`];
  const testText = readFileSync(testPath, 'utf8');
  const caller = jobBlock(testText, 'native-adapter');
  if (caller === null) return [...out, `${TEST_WORKFLOW}: no native-adapter job; merge-queue batches would merge without the native adapter (#8408, #8415)`];
  if (!/^ {4}uses: \.\/\.github\/workflows\/geometry-platform\.yml\s*$/m.test(caller) || !/^ {4}with:\n {6}batch: true\s*$/m.test(caller)) {
    out.push(`${TEST_WORKFLOW}: the native-adapter job must call ./${WORKFLOW} with batch: true`);
  }
  // The job's own grant sits at indent 4; nothing deeper stands in for it.
  const callerGrant = permissionBlocks(caller, out, TEST_WORKFLOW).find((b) => b.indent === 4)?.scopes ?? {};
  for (const { scopes } of workflowAsks(root, WORKFLOW, out, text)) {
    for (const [scope, level] of Object.entries(scopes)) {
      if (level !== 'none' && callerGrant[scope] !== level && callerGrant[scope] !== 'write') out.push(`${TEST_WORKFLOW}: the native-adapter call must grant ${scope}: ${level}; ${WORKFLOW} asks for it and GitHub refuses the whole Test run otherwise`);
    }
  }
  if (!caller.split('\n').some((l) => l === `    if: ${BATCH_CALL_IF}`)) {
    out.push(`${TEST_WORKFLOW}: the native-adapter job must be gated on exactly: if: ${BATCH_CALL_IF} (batches only, and only an explicit \`false\` skips)`);
  }
  // `batch` must not hang on the classifier alone: it is continue-on-error.
  if (!(jobBlock(testText, 'changes') ?? '').includes(`batch: \${{ steps.lane.outputs.batch || (startsWith(github.head_ref, 'mergify/merge-queue/') && 'true' || 'false') }}`)) {
    out.push(`${TEST_WORKFLOW}: the changes job's batch output must fall back on the mergify/merge-queue/ head ref, or a crashed lane step skips the native adapter on a queue run`);
  }
  if (!/^ {6}native_adapter: \$\{\{ steps\.nativeadapter\.outputs\.native_adapter \}\}\s*$/m.test(jobBlock(testText, 'changes') ?? '')) {
    out.push(`${TEST_WORKFLOW}: the changes job must publish native_adapter from its nativeadapter step`);
  }
  const decide = testText.match(/^ {6}- name: [^\n]*\n {8}id: nativeadapter\n((?: {8}.*\n)+)/m);
  if (!decide || !decide[1].includes(`run: ${BATCH_DECIDE_RUN}`) || !/^ {8}continue-on-error: true\s*$/m.test(decide[1])) {
    out.push(`${TEST_WORKFLOW}: the changes job needs a continue-on-error step with id nativeadapter running ${BATCH_DECIDE_RUN}`);
  }
  const aggregate = jobBlock(testText, 'test') ?? '';
  const needs = aggregate.match(/^ {4}needs: \[([^\]]*)\]/m);
  if (!needs || !needs[1].split(',').map((s) => s.trim()).includes('native-adapter')) {
    out.push(`${TEST_WORKFLOW}: the Build + WASM + Rust + Node aggregate must need native-adapter, or a failing batch run merges`);
  }
  return out;
}

/** The batch decision, reading the lists and the matcher from the batch's HEAD. */
function batchDecision(root) {
  let pr;
  let decider;
  try {
    pr = eventPaths(readFileSync(join(root, WORKFLOW), 'utf8'), 'pull_request');
    // A batch that edits the lists or the matcher could drop the very path it touches.
    decider = scriptImports(root, [SELF]).add(WORKFLOW);
  } catch (err) {
    return { run: true, reason: `cannot read what the decision reads (${err.message.split('\n')[0]}); running` };
  }
  if (!pr || pr.length === 0) return { run: true, reason: `${WORKFLOW} has no on.pull_request.paths; running` };
  return decideBatch(root, pr, decider);
}

if (isMainEntry(import.meta.url)) {
  const flag = process.argv.indexOf('--root');
  const root = flag !== -1 && process.argv[flag + 1] ? process.argv[flag + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--batch-decide')) {
    const d = batchDecision(root);
    console.log(`[native-adapter] merge-queue batch: native_adapter=${d.run}: ${d.reason}`);
    if (!process.env.GITHUB_OUTPUT) {
      console.error('❌ GITHUB_OUTPUT is not set; refusing to decide into nowhere');
      process.exit(1);
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `native_adapter=${d.run}\n`);
    process.exit(0);
  }
  const failures = audit(root);
  if (failures.length > 0) {
    console.error(`❌ check-native-adapter-triggers: ${failures.length} problem(s)\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`✅ check-native-adapter-triggers: ${crateClosure(root).length} crates covered; opt-in PR lane, merge-queue batch route and nightly guard intact`);
}
