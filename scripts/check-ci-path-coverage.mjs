#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ratchet: a CI gate may not read a path that cannot trigger it.
 *
 * THE DEFECT CLASS. A gate script is only as good as the job that runs it, and
 * that job only runs when the path filter says so. When a gate's INPUT is
 * outside its own TRIGGER the gate is not weak, it is unreachable: the PR that
 * introduces the very mistake it guards against is the PR on which it does not
 * run, and the aggregate `test` gate reports success because a skipped job
 * counts as success. Four real instances, all reproduced before this check was
 * written:
 *
 *   - `scripts/check-swallowed-push.mjs` declares its SCOPE to be
 *     `.github/workflows/**` and ran in a job that only 2 of the 15 workflow
 *     files could trigger. PR #3118 edited `release.yml` and `docker.yml`;
 *     Node tests SKIPPED.
 *   - `pnpm test:integration` runs `tests/integration.test.ts`, which was in no
 *     filter -- the test could not trigger its own execution.
 *   - `scripts/docs/generate-docs-sections.mjs --check` regenerates from
 *     `tests/benchmark/baseline.json` and `apps/landing/app.jsx`, neither of
 *     which was in any filter. PR #1817 changed only
 *     `apps/landing/bench-data.json`; Node tests AND Docs checks both skipped
 *     and the required check went green.
 *   - `apps/landing/**` appeared in no filter at all while four gates walk
 *     `apps/`.
 *
 * WHAT THIS DOES. For every workflow under `.github/workflows`, it derives
 *   (a) which `node scripts/...` gates each job runs,
 *   (b) the globs that can trigger that job -- the workflow's own
 *       `on.pull_request.paths`, or, for `test.yml`, the union of the
 *       `changes` filters its `if:` names, and
 *   (c) the repo paths each gate script READS, read out of the gate's own
 *       source (path literals and `join(ROOT, ...)` chains that resolve to
 *       something real).
 * Then it reports every file that a gate reads and no glob can trigger it on.
 *
 * WHAT THE CENSUS DOES NOT SEE, STATED PLAINLY. Step (a) matches only a literal
 * `node scripts/*.mjs` in a step's `run:`, so a gate invoked through a package
 * script is invisible to it: `pnpm lint` runs four gates
 * (`check-changesets`, `check-test-glob-coverage`, `check-unused-locals`,
 * `check-lint-ran`), and `check:vitest-timeout-audit` and `fixtures:check` each
 * run one more. All six were walked by hand when this check was written and
 * none is outside its own trigger today, so this is a KNOWN LIMIT of the
 * census, not a hole it is hiding: those six are not covered by anything here,
 * and a future path filter change could open a hole in one without this check
 * noticing. Teaching it to resolve `pnpm <script>` through package.json is the
 * fix, and is deliberately not part of this change.
 *
 * FAILS CLOSED. No workflows, no jobs, no gates, a filter block that parses to
 * nothing, an unreadable workflow, zero derived inputs, or an allowlist entry
 * that no longer matches anything -- each is a NAMED failure, never a pass.
 * "Found nothing" and "nothing to find" are different answers and this refuses
 * to conflate them.
 *
 * REQUIRED BY NAME. `REQUIRED_COVERAGE` below pins the four specific facts
 * above. A count floor would survive dropping the one entry that matters; a
 * named assertion does not.
 *
 * ITS OWN CONFIG IS INSIDE ITS OWN TRIGGER -- the defect it detects. This file
 * and `scripts/ci-path-coverage-allowlist.txt` both live under `scripts/`,
 * which the `frontend` filter carries, and `assertSelfCoverage` proves it
 * rather than asserting it in prose.
 *
 * Run via `node scripts/check-ci-path-coverage.mjs` (CI Node tests job).
 * `--root <dir>` points it at a mutated copy of the tree; that is how
 * `check-ci-path-coverage.test.mjs` proves it fires.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseFilterBlock,
  splitJobs,
  gatingFilters,
  parseWorkflowPrPaths,
  deriveInputs,
  matchesAny,
  gitignoreToGlobs,
} from './lib/ci-path-coverage.mjs';

const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? process.argv[rootFlag + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');

const WORKFLOW_DIR = '.github/workflows';
const FILTER_WORKFLOW = '.github/workflows/test.yml';
const ALLOWLIST = 'scripts/ci-path-coverage-allowlist.txt';
const SELF = 'scripts/check-ci-path-coverage.mjs';

/**
 * The facts this check exists to hold, asserted by NAME.
 *
 * Each entry is `[gate script, an input file of that gate]`. The check proves
 * the gate is reachable from that exact file. Dropping any of these from the
 * filters is the regression; a count of covered inputs would not notice.
 */
const REQUIRED_COVERAGE = [
  ['scripts/check-swallowed-push.mjs', '.github/workflows/release.yml'],
  ['scripts/check-swallowed-push.mjs', '.github/workflows/docker.yml'],
  ['scripts/check-test-wiring.mjs', 'tests/integration.test.ts'],
  ['scripts/docs/generate-docs-sections.mjs', 'tests/benchmark/baseline.json'],
  ['scripts/docs/generate-docs-sections.mjs', 'apps/landing/app.jsx'],
  ['scripts/docs/generate-docs-sections.mjs', 'apps/landing/bench-data.json'],
];

const failures = [];
function fail(reason) {
  failures.push(reason);
}

const abs = (p) => join(ROOT, p);
const exists = (p) => existsSync(abs(p));

/**
 * Everything `.gitignore` excludes, as globs.
 *
 * The walk must see COMMITTED content and nothing else. Untracked output --
 * `node_modules` after an install, a package's `dist` after a build, the
 * fetched `.ifc` corpus under `tests/models` -- can never be what a `paths:`
 * filter matches, but while the walk could see it the verdict moved with the
 * state of the working tree: this check passed on a clean checkout and failed
 * in CI on the identical commit. A check whose answer depends on what was
 * built last is not evidence about the commit.
 */
const IGNORED = exists('.gitignore')
  ? gitignoreToGlobs(readFileSync(abs('.gitignore'), 'utf8'))
  : [];
const isIgnored = (rel) => IGNORED.length > 0 && matchesAny(rel, IGNORED);

// ---------------------------------------------------------------------------
// 1. The filter block.
// ---------------------------------------------------------------------------

if (!exists(FILTER_WORKFLOW)) {
  console.error(`❌ check-ci-path-coverage: ${FILTER_WORKFLOW} is missing.`);
  process.exit(1);
}

let filters;
try {
  filters = parseFilterBlock(readFileSync(abs(FILTER_WORKFLOW), 'utf8'));
} catch (err) {
  console.error(`❌ check-ci-path-coverage: cannot parse the path filters -- ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Workflows -> jobs -> gates, with the globs that can trigger each.
//    `null` glob set means "no path filter", i.e. every path triggers it.
// ---------------------------------------------------------------------------

let workflowFiles;
try {
  workflowFiles = readdirSync(abs(WORKFLOW_DIR))
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
} catch (err) {
  console.error(`❌ check-ci-path-coverage: cannot read ${WORKFLOW_DIR} -- ${err.message}`);
  process.exit(1);
}
if (workflowFiles.length === 0) {
  console.error(`❌ check-ci-path-coverage: no workflow files under ${WORKFLOW_DIR}.`);
  process.exit(1);
}

/** gate script -> { globs: string[] | null, sites: string[] } */
const gates = new Map();
let jobCount = 0;

function recordGate(gate, globs, site) {
  const prev = gates.get(gate);
  if (!prev) {
    gates.set(gate, { globs, sites: [site] });
    return;
  }
  prev.sites.push(site);
  // A gate reachable from ANY job with no path filter is fully reachable.
  if (prev.globs === null || globs === null) prev.globs = null;
  else prev.globs = [...new Set([...prev.globs, ...globs])];
}

for (const file of workflowFiles) {
  const rel = `${WORKFLOW_DIR}/${file}`;
  let text;
  try {
    text = readFileSync(abs(rel), 'utf8');
  } catch (err) {
    console.error(`❌ check-ci-path-coverage: cannot read ${rel} -- ${err.message}`);
    process.exit(1);
  }

  // Named, with the workflow that caused it. These parsers throw on a shape
  // they cannot read rather than returning a wider answer, so the throw IS the
  // check firing -- reporting it as an uncaught stack trace would leave the
  // reader to work out which of 26 workflows it came from.
  let triggersOnPr;
  let prPaths;
  let jobs;
  try {
    ({ triggersOnPr, paths: prPaths } = parseWorkflowPrPaths(text));
    if (!triggersOnPr) continue; // release/cron-only workflows gate nothing on a PR
    jobs = splitJobs(text);
  } catch (err) {
    console.error(`❌ check-ci-path-coverage: cannot read the triggers of ${rel} -- ${err.message}`);
    process.exit(1);
  }

  if (jobs.length === 0) {
    console.error(`❌ check-ci-path-coverage: ${rel} triggers on PRs but parsed to zero jobs.`);
    process.exit(1);
  }
  jobCount += jobs.length;

  for (const job of jobs) {
    const named = gatingFilters(job.text);
    let globs;
    if (rel === FILTER_WORKFLOW) {
      if (named === null) {
        globs = prPaths; // may itself be null = everything
      } else {
        const unknown = named.filter((n) => !filters.has(n));
        if (unknown.length > 0) {
          console.error(
            `❌ check-ci-path-coverage: job ${job.id} gates on unknown filter(s) ` +
              `${unknown.join(', ')} -- the filter block and the job wiring disagree.`,
          );
          process.exit(1);
        }
        globs = named.flatMap((n) => filters.get(n));
        if (prPaths !== null) {
          console.error(
            `❌ check-ci-path-coverage: ${rel} has BOTH on.pull_request.paths and ` +
              `a changes-filter job gate; this check cannot intersect them safely.`,
          );
          process.exit(1);
        }
      }
    } else {
      globs = prPaths;
    }

    for (const m of job.text.matchAll(/\bnode\s+(?:--test\s+)?((?:scripts\/[\w./-]+\.mjs\s*)+)/g)) {
      for (const script of m[1].trim().split(/\s+/)) {
        recordGate(script, globs, `${rel}:${job.id}`);
      }
    }
  }
}

if (jobCount === 0) {
  console.error('❌ check-ci-path-coverage: no PR-triggered jobs found in any workflow.');
  process.exit(1);
}
if (gates.size === 0) {
  console.error(
    '❌ check-ci-path-coverage: no `node scripts/*.mjs` gates found in any workflow. ' +
      'Either the workflows stopped running gate scripts, or the step-parsing regex no longer matches them.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Derive each gate's inputs from its own source.
// ---------------------------------------------------------------------------

/** gate -> input paths */
const gateInputs = new Map();
let totalInputs = 0;

for (const [gate, info] of gates) {
  if (!exists(gate)) {
    console.error(
      `❌ check-ci-path-coverage: a workflow runs ${gate}, which does not exist in the tree.`,
    );
    process.exit(1);
  }
  // An ignored path is not a source input: it cannot be committed, so it can
  // never be what a `paths:` filter matches. Dropping it HERE as well as in
  // the walk keeps the reported input COUNT a function of the commit too --
  // otherwise a warmed fixture cache silently moves the number in the summary.
  const derived = deriveInputs(readFileSync(abs(gate), 'utf8'), (q) => exists(q) && !isIgnored(q));
  // A gate's own source file is trivially an input; keep it, it is the
  // self-coverage case and it must hold for every gate, not just this one.
  const inputs = [...new Set([gate, ...derived])].sort();
  gateInputs.set(gate, { inputs, globs: info.globs, sites: info.sites });
  totalInputs += inputs.length;
}

if (totalInputs === 0) {
  console.error(
    '❌ check-ci-path-coverage: derived zero input paths from every gate script. ' +
      'The literal-extraction in scripts/lib/ci-path-coverage.mjs has stopped working.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Allowlist.
// ---------------------------------------------------------------------------

if (!exists(ALLOWLIST)) {
  console.error(`❌ check-ci-path-coverage: ${ALLOWLIST} is missing.`);
  process.exit(1);
}
const allow = [];
for (const [n, raw] of readFileSync(abs(ALLOWLIST), 'utf8').split('\n').entries()) {
  const line = raw.trim();
  if (line === '' || line.startsWith('#')) continue;
  const m = line.match(/^(\S+)\s+(\S+)\s+#\s*(.+)$/);
  if (!m) {
    console.error(
      `❌ check-ci-path-coverage: ${ALLOWLIST}:${n + 1} is not ` +
        '`<gate> <path-glob> # <reason>`. Every exemption needs a written reason.',
    );
    process.exit(1);
  }
  allow.push({ gate: m[1], glob: m[2], reason: m[3], used: false, line: n + 1 });
}

// ---------------------------------------------------------------------------
// 5. The mechanical diff.
// ---------------------------------------------------------------------------

/** Files under a repo-relative path. Only walked when no glob covers the subtree. */
const walkCache = new Map();
function filesUnder(rel) {
  const hit = walkCache.get(rel);
  if (hit) return hit;
  const out = walkUncached(rel);
  walkCache.set(rel, out);
  return out;
}

function walkUncached(rel) {
  // Asked about an ignored node directly: it is not committed, so it
  // contributes no files. Belt and braces -- the derivation above already
  // declines to hand an ignored path to the walk, so nothing observable
  // depends on this line today. It is here because the old skip set filtered
  // only a walk's CHILDREN and never the root it was asked about, which is the
  // shape that let `node_modules` be enumerated once the derivation admitted
  // it; a future change to the derivation must not be able to reopen it.
  if (isIgnored(rel)) return [];
  const target = abs(rel);
  let st;
  try {
    st = statSync(target);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [rel];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && dir === target && rel !== WORKFLOW_DIR) continue;
      const full = join(dir, entry.name);
      const child = relative(ROOT, full).split(sep).join('/');
      if (isIgnored(child)) continue;
      if (entry.isDirectory()) walk(full);
      else out.push(child);
    }
  };
  walk(target);
  return out;
}

/**
 * The SHALLOWEST uncovered nodes under `rel` -- a whole directory when nothing
 * inside it is reachable, individual files when only some of it is.
 *
 * Granularity is the difference between a usable report and an unusable one:
 * `apps` un-reduced yields 27 file lines that all say the same thing, and the
 * one line worth reading (`apps/landing`) is buried among the favicons. It is
 * also the granularity an exemption should be written at.
 */
function uncoveredNodes(rel, globs) {
  if (matchesAny(rel, globs)) return [];
  const files = filesUnder(rel);
  if (files.length === 0) return [];
  if (files.length === 1 && files[0] === rel) return [rel];
  if (files.every((f) => !matchesAny(f, globs))) return [rel];

  const byChild = new Map();
  for (const f of files) {
    if (matchesAny(f, globs)) continue;
    const slash = f.indexOf('/', rel.length + 1);
    // No further separator: `f` is a FILE directly in `rel`, so it is its own
    // node. Slicing at -1 here silently truncated the last character and
    // reported paths that do not exist.
    const key = slash === -1 ? f : f.slice(0, slash);
    if (!byChild.has(key)) byChild.set(key, []);
    byChild.get(key).push(f);
  }
  const out = [];
  for (const [child, uncovered] of byChild) {
    if (child === rel) continue;
    const all = filesUnder(child);
    if (all.length === uncovered.length) out.push(child);
    else out.push(...uncoveredNodes(child, globs));
  }
  return out;
}

const violations = [];

for (const [gate, info] of gateInputs) {
  if (info.globs === null) continue; // job has no path filter: everything reaches it
  for (const input of info.inputs) {
    for (const node of uncoveredNodes(input, info.globs)) {
      const hit = allow.find((a) => a.gate === gate && matchesAny(node, [a.glob]));
      if (hit) {
        hit.used = true;
        continue;
      }
      if (!violations.some((v) => v.gate === gate && v.file === node)) {
        violations.push({ gate, file: node, sites: [...new Set(info.sites)] });
      }
    }
  }
}

const unused = allow.filter((a) => !a.used);
if (unused.length > 0) {
  for (const a of unused) {
    fail(
      `${ALLOWLIST}:${a.line} exempts ${a.gate} / ${a.glob}, which is now covered (or gone). ` +
        'Delete the line -- a stale exemption hides the next hole.',
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Required-by-name, and self-coverage.
// ---------------------------------------------------------------------------

for (const [gate, file] of REQUIRED_COVERAGE) {
  const info = gateInputs.get(gate);
  if (!info) {
    // Only a claim about THIS repo. A tree that does not run the gate at all
    // (the synthetic fixtures in check-ci-path-coverage.test.mjs) is not a
    // regression; a tree that HAS the gate and stopped running it is.
    if (exists(gate)) fail(`REQUIRED_COVERAGE names ${gate}, which no workflow runs any more.`);
    continue;
  }
  if (!exists(file)) {
    fail(`REQUIRED_COVERAGE names ${file}, which is not in the tree.`);
    continue;
  }
  if (info.globs === null) continue;
  if (!matchesAny(file, info.globs)) {
    fail(
      `${file} cannot trigger ${gate}. The gate runs in ${info.sites.join(', ')}, ` +
        'and no glob in that job’s filters matches this file.',
    );
  }
}

function assertSelfCoverage() {
  const info = gateInputs.get(SELF);
  if (!info) {
    fail(`${SELF} is not run by any workflow job -- this check cannot check itself.`);
    return;
  }
  if (info.globs === null) return;
  for (const own of [SELF, ALLOWLIST, 'scripts/lib/ci-path-coverage.mjs']) {
    if (!matchesAny(own, info.globs)) {
      fail(
        `${own} is this check’s own config and cannot trigger it -- the exact defect ` +
          'this check detects. Add it to a filter that reaches ' +
          `${info.sites.join(', ')}.`,
      );
    }
  }
}
assertSelfCoverage();

// ---------------------------------------------------------------------------
// 7. Report.
// ---------------------------------------------------------------------------

if (violations.length > 0) {
  const byGate = new Map();
  for (const v of violations) {
    if (!byGate.has(v.gate)) byGate.set(v.gate, { sites: v.sites, files: [] });
    byGate.get(v.gate).files.push(v.file);
  }
  for (const [gate, { sites, files }] of byGate) {
    const shown = files.slice(0, 8);
    fail(
      `${gate} (runs in ${sites.join(', ')}) reads ${files.length} file(s) that cannot trigger it:\n` +
        shown.map((f) => `      - ${f}`).join('\n') +
        (files.length > shown.length ? `\n      ... and ${files.length - shown.length} more` : ''),
    );
  }
}

if (failures.length > 0) {
  console.error(
    `\n❌ check-ci-path-coverage: ${failures.length} gate input(s) outside their own trigger.\n`,
  );
  for (const f of failures) console.error(`  • ${f}`);
  console.error(
    '\nA gate that cannot run on the files it guards is not a weak gate, it is an absent one:\n' +
      'the PR introducing the mistake is exactly the PR the job skips, and a skipped job\n' +
      "counts as success in the aggregate `test` gate. Fix by adding the path to the CHEAPEST\n" +
      `filter in ${FILTER_WORKFLOW} that reaches the job, or record a reasoned exemption in\n` +
      `${ALLOWLIST}.\n`,
  );
  process.exit(1);
}

console.log(
  `✅ check-ci-path-coverage: ${gates.size} gate(s) across ${jobCount} PR-triggered job(s); ` +
    `${totalInputs} derived input path(s), all inside their own trigger ` +
    `(${allow.length} reasoned exemption(s)).`,
);
