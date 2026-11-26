#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BASE-STALE SIGNAL: would a PR's last perf-ratchet / Rust result still hold
 * on CURRENT main? An earlier signal than the merge queue, never a substitute
 * for it: the queue still runs the full suite on the exact merged tree. The
 * decision is `scripts/lib/base-stale.mjs`; this file gathers its inputs.
 *
 * WHY. Merge-queue runs take ~40 minutes (batch size 1, two in parallel) and
 * 22.9% were red over 2026-11-20..23. A repeat cause: a PR passes the
 * perf ratchet against an older main, main then grows to within 0.10% of a
 * ceiling, and the PR fails only in the queue (runs 45001383910 and
 * 45039295698, 50-360 B over `bundle/viewer-eager-js-bytes`). Rust PRs show
 * the same pattern. A red queue run costs the queue slot and the PR behind it.
 *
 * THE SWITCH is the repo variable `CI_BASE_STALE_GATE`:
 *   unset / `shadow` / anything else   advisory: the verdict goes to the log
 *       and the step summary ("would block: <reason>"). Nothing is posted,
 *       failed or held, except that a non-success `PR base staleness` status
 *       an earlier `on` run left is overwritten with a success (so deleting the
 *       variable releases every held PR on its next evaluation).
 *   `on`   the verdict is also a commit status, `PR base staleness`, on the PR
 *       head: `failure` when stale, `success` otherwise (an `unknown` verdict
 *       says "Not judged" and does not hold). Mergify reads it once
 *       `.mergify.yml`'s `auto_merge_conditions` carries
 *       `-check-failure=PR base staleness` (not added here; see the PR).
 *
 * WHEN A VERDICT IS (RE)EVALUATED. An open PR's CI does not re-run when main
 * moves, so a verdict is only as fresh as its last evaluation:
 *   1. `--in-run`: the PR's own Test run, last step of the `perf-ratchet` job,
 *      from that run's own measurement. This is what refreshes a PR after its
 *      author merges main or pushes.
 *   2. `--sweep`: every push to main (.github/workflows/base-stale.yml)
 *      re-evaluates every open, non-draft PR labelled `mergify-trial`.
 *   3. `--pr N`: the label being added (the moment a PR asks for the queue),
 *      or a manual dispatch.
 * An unlabelled PR is therefore judged against the main of its last run until
 * it is labelled. Every logged verdict names the main tip it was judged
 * against and the trigger, so the shadow log never claims more freshness than
 * it has.
 *
 *   node scripts/ci-base-stale.mjs --sweep [--cache <file>] [--json-out <file>]
 *   node scripts/ci-base-stale.mjs --pr <n> [--json-out <file>]
 *   node scripts/ci-base-stale.mjs --in-run --pr <n> --head-sha <sha> --merge-sha <sha> --measured-dir <dir>
 *   common: [--main-sha <sha>] [--pr-run <run id>] (replay a past decision) [--dry-run] (never post)
 *
 * Env: GH_TOKEN, GITHUB_REPOSITORY, CI_BASE_STALE_GATE, GITHUB_STEP_SUMMARY,
 * GITHUB_SERVER_URL/GITHUB_RUN_ID (status target link), HEAD_REPO (in-run fork check).
 * Exit 0 with verdicts (a per-PR fault is an `unknown` verdict); exit 2 on a
 * harness fault (bad arguments, main unreadable). It never exits 1.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatingFilters, parseFilterBlock, splitJobs } from './lib/ci-path-coverage.mjs';
import { combine, evaluatePerf, evaluateRust, parseGateMode, prRelevance, QUEUE_LABEL, STATUS_CONTEXT, statusFor, summaryLine } from './lib/base-stale.mjs';
import { BudgetError, createIo, slim } from './lib/base-stale-io.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { loadMeasuredFile } from './perf-ratchet/ceilings.mjs';

/** Below this many core API requests left, a run stops rather than starve other workflows. */
export const RATE_FLOOR = 300;
/**
 * Most counted calls one run may make. Measured 2026-11-26 over the 7 labelled
 * PRs then open: a cold sweep made 71 calls, a warm one (no head moved) 15.
 */
export const CALL_CAP = { sweep: 150, single: 60 };
/** Below this the setup reads (main's tip, its ceilings, the PR list) may not fit: skip instead. */
export const MIN_ALLOWANCE = 10;

/**
 * This run's allowance: at most half of what is left above the floor, and
 * never more than the cap. Each run spends at most half the headroom, so
 * however many main pushes land in an hour, this workflow alone cannot take
 * the shared token below RATE_FLOOR, and a busy hour backs off on its own.
 */
export function callAllowance(remaining, cap) {
  if (remaining === null) return cap;
  const n = Math.min(cap, Math.floor((remaining - RATE_FLOOR) / 2));
  return n < MIN_ALLOWANCE ? 0 : n;
}

export function parseArgs(argv) {
  const opts = { mode: null, pr: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--sweep') opts.mode = 'sweep';
    else if (flag === '--in-run') opts.mode = 'in-run';
    else if (flag === '--pr') opts.pr = Number(value());
    else if (flag === '--head-sha') opts.headSha = value();
    else if (flag === '--merge-sha') opts.mergeSha = value();
    else if (flag === '--measured-dir') opts.measuredDir = value();
    else if (flag === '--main-sha') opts.mainSha = value();
    else if (flag === '--pr-run') {
      const raw = value();
      if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--pr-run needs a run id, got ${raw}`);
      opts.prRun = Number(raw);
    }
    else if (flag === '--cache') opts.cache = value();
    else if (flag === '--json-out') opts.jsonOut = value();
    else if (flag === '--trigger') opts.trigger = value();
    else if (flag === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown option ${flag}`);
  }
  if (opts.mode === null && opts.pr !== null) opts.mode = 'pr';
  if (!opts.mode) throw new Error('usage: ci-base-stale.mjs --sweep | --pr <n> | --in-run --pr <n> ...');
  if (opts.mode !== 'sweep' && !(Number.isInteger(opts.pr) && opts.pr > 0)) throw new Error('--pr <n> is required');
  if (opts.mode === 'in-run' && !(opts.headSha && opts.mergeSha && opts.measuredDir)) {
    throw new Error('--in-run needs --head-sha, --merge-sha and --measured-dir');
  }
  return opts;
}

/** The perf-ratchet job's gating filters and the `rust` filter, read from test.yml. */
export function readFilterGlobs(workflowText) {
  const filters = parseFilterBlock(workflowText);
  const job = splitJobs(workflowText).find((j) => j.id === 'perf-ratchet');
  if (!job) throw new Error('test.yml has no perf-ratchet job');
  const gating = gatingFilters(job.text, 'perf-ratchet');
  if (!gating?.length) throw new Error('the perf-ratchet job is not path-gated; cannot derive its inputs');
  const perfGlobs = gating.flatMap((name) => {
    const globs = filters.get(name);
    if (!globs) throw new Error(`perf-ratchet is gated on filter ${name}, which test.yml does not define`);
    return globs;
  });
  const rustGlobs = filters.get('rust');
  if (!rustGlobs) throw new Error('test.yml defines no `rust` filter');
  return { perfGlobs, rustGlobs };
}

/**
 * Judge one PR. Never throws: a fault while gathering inputs is an `unknown`
 * verdict naming it, so one unreadable PR neither passes nor stops the sweep.
 */
export function evaluatePr(io, { pr, headSha, mainTip, ceilings, globs, measured = null, prRun = null }) {
  const record = { pr, head: headSha, mainTip, testedBase: null, prRun: null };
  try {
    const files = io.prFiles(pr, headSha);
    const rel = prRelevance(files, globs);
    let prMeasured = null;
    if (measured) {
      prMeasured = measured.families.map(slim);
      record.testedBase = io.mergeParents(measured.mergeSha, headSha);
    } else if (rel.perf || rel.rust) {
      const m = io.prMeasurement(headSha, prRun);
      if (m) {
        prMeasured = m.families;
        record.testedBase = m.testedBase;
        record.prRun = m.runId;
      }
    }
    const tb = record.testedBase;
    const sameMain = tb === mainTip;
    let perf;
    if (rel.perf && prMeasured && !tb) {
      perf = { verdict: 'unknown', reasons: ["the PR measurement's base could not be read"], rows: [] };
    } else {
      const needsMain = rel.perf && prMeasured && !rel.editsCeilings;
      // Main has not moved since the PR was measured: main at the base IS main
      // now, so the drift is zero by construction, not by absence.
      const atTip = sameMain ? { sha: tb, behindTip: 0, families: prMeasured } : null;
      perf = evaluatePerf({
        relevant: rel.perf,
        editsCeilings: rel.editsCeilings,
        prMeasured,
        testedBase: tb,
        ceilings,
        mainAtBase: needsMain ? (atTip ?? io.mainMeasurementAt(tb)) : null,
        mainLatest: needsMain ? (atTip ?? io.latestMainMeasurement(mainTip)) : null,
      });
    }
    const moved = rel.rust && tb ? (sameMain ? { files: [], commits: 0, capped: false } : io.movedSince(tb, mainTip)) : null;
    const rust = evaluateRust({ relevant: rel.rust, prFiles: files, rustGlobs: globs.rustGlobs, testedBase: tb, moved });
    return { ...record, ...combine(perf, rust), perf: { verdict: perf.verdict, rows: perf.rows }, rust: { verdict: rust.verdict, mainRustFiles: rust.mainRustFiles, overlap: rust.overlap } };
  } catch (err) {
    const budget = err instanceof BudgetError;
    return { ...record, verdict: 'unknown', reasons: [`${budget ? 'not judged' : 'harness'}: ${err.message.split('\n')[0]}`], ...(budget ? { budget: true } : {}) };
  }
}

/** The filters from a workflow file on disk (test.yml by default). */
export function loadFilterGlobs(path = '.github/workflows/test.yml') {
  return readFilterGlobs(readFileSync(path, 'utf8'));
}

export function loadCache(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data?.version === 1 ? data : null;
  } catch (err) {
    console.log(`base-stale: ignoring an unreadable cache (${err.message})`);
    return null;
  }
}

/**
 * A sweep prunes per-head entries to the heads it just judged (the labelled
 * PRs); a single-PR run keeps every entry, or it would empty the sweep's cache.
 *
 * `lastMode` is the gate mode of the last sweep that read every head it had
 * to. Only such a sweep may move it: a single-PR run, or a sweep cut short by
 * the API budget, carries the old value through, so the first complete sweep
 * after `on` still reads every labelled head's status and releases the
 * failures the in-run step posted (they are not in `posted`).
 */
function saveCache(path, store, liveHeads, lastMode) {
  if (!path) return;
  const live = (map) => Object.fromEntries(Object.entries(map ?? {}).filter(([head]) => !liveHeads || liveHeads.has(head)));
  // Main entries are immutable per tree; keep the newest 400 so the file stays small.
  const main = Object.entries(store.mainMeasurements).slice(-400);
  writeFileSync(path, JSON.stringify({
    version: 1,
    mainMeasurements: Object.fromEntries(main),
    prMeasurements: live(store.prMeasurements),
    prFiles: live(store.prFiles),
    posted: live(store.posted),
    lastMode,
  }));
}

function finish(opts, records, extra) {
  const lines = records.map((r) => summaryLine({ ...r, trigger: opts.trigger ?? opts.mode }));
  for (const r of records) console.log(`BASE_STALE_VERDICT ${JSON.stringify(r)}`);
  const header = `### Base-stale signal (${extra.gateMode}${opts.dryRun ? ', dry run' : ''})\n\n` +
    `Judged against main ${String(extra.mainTip).slice(0, 9)} at ${extra.evaluatedAt}. A verdict is refreshed on the PR's next run, ` +
    'on every push to main for labelled PRs, and when the queue label is added; until then it is only as fresh as this.\n\n';
  const allowed = extra.allowance === undefined || extra.allowance === Infinity ? '' : ` of ${extra.allowance} allowed`;
  const body = `${header}${lines.join('\n') || '- no PR evaluated'}\n\nAPI calls: ${extra.stats.calls}${allowed} (${extra.stats.downloads} downloads, ${extra.stats.cacheHits} cache hits)\n`;
  console.log(body);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  // test.yml names the in-run upload after the mode the script parsed.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `gate-mode=${extra.gateMode}\n`);
  if (opts.jsonOut) writeFileSync(opts.jsonOut, records.map((r) => JSON.stringify({ ...r, ...extra, stats: undefined })).join('\n') + (records.length ? '\n' : ''));
}

export function run(opts, env = process.env, makeIo = createIo) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  const gateMode = parseGateMode(env.CI_BASE_STALE_GATE);
  const cache = loadCache(opts.cache);
  const io = makeIo({ repo, cache });
  const evaluatedAt = new Date().toISOString();
  const sweep = opts.mode === 'sweep';
  // `rate_limit` is free; read it before spending anything.
  const allowance = callAllowance(io.coreRemaining(), sweep ? CALL_CAP.sweep : CALL_CAP.single);
  if (allowance === 0) {
    console.log(`::notice title=base-stale::skipped: under ${RATE_FLOOR} core API requests to spare; verdicts are not refreshed this time`);
    finish(opts, [], { gateMode, mainTip: opts.mainSha ?? 'not read', evaluatedAt, stats: io.stats, skipped: 'rate-floor' });
    return 0;
  }
  io.setBudget(allowance);
  const globs = loadFilterGlobs();
  let mainTip = opts.mainSha ?? null;
  let ceilings;
  let candidates = null;
  try {
    mainTip ??= io.mainTip();
    ceilings = io.ceilingsAt(mainTip);
    if (sweep) candidates = io.queueCandidates(QUEUE_LABEL);
  } catch (err) {
    // Spent before any PR was judged: the same honest skip as the floor.
    if (!(err instanceof BudgetError)) throw err;
    console.log(`::notice title=base-stale::skipped: ${err.message}; verdicts are not refreshed this time`);
    finish(opts, [], { gateMode, mainTip: mainTip ?? 'not read', evaluatedAt, stats: io.stats, allowance, skipped: 'budget' });
    return 0;
  }
  const targetUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;

  // Shadow sweep: the heads an in-run step judged with the gate on. A failed
  // lookup reads every head instead (null), the safe direction.
  let onHeads = new Set();
  if (sweep && gateMode !== 'on' && !opts.dryRun && cache?.lastMode === 'shadow') {
    try {
      onHeads = io.inRunOnHeads();
    } catch (err) {
      console.log(`::warning title=base-stale::could not list in-run verdicts posted with the gate on (${err.message.split('\n')[0]}); reading every head's status`);
      onHeads = null;
    }
  }

  let targets;
  if (sweep) {
    targets = candidates.map((p) => ({ pr: p.number, headSha: p.headRefOid, fork: p.isCrossRepository }));
  } else if (opts.mode === 'in-run') {
    // No download (the measurement step failed): fall back to the PR's newest
    // earlier measurement, which the decision then dates honestly.
    const measured = existsSync(opts.measuredDir)
      ? { families: readdirSync(opts.measuredDir).filter((n) => n.endsWith('.json')).sort().map((f) => loadMeasuredFile(join(opts.measuredDir, f))), mergeSha: opts.mergeSha }
      : null;
    targets = [{ pr: opts.pr, headSha: opts.headSha, fork: Boolean(env.HEAD_REPO) && env.HEAD_REPO !== repo, measured }];
  } else {
    targets = [{ pr: opts.pr, headSha: null, fork: false }];
  }

  const records = [];
  // Whether every head this sweep had to read was read; see saveCache.
  let complete = true;
  let stopped = null;
  for (const t of targets) {
    if (!stopped && sweep && records.length > 0) {
      // Other workflows spend the same token while this one runs.
      const left = io.coreRemaining();
      if (left !== null && left < RATE_FLOOR) stopped = `${left} core API requests left (floor ${RATE_FLOOR})`;
    }
    if (stopped) {
      complete = false;
      records.push({ pr: t.pr, head: t.headSha, mainTip, verdict: 'unknown', reasons: [`not judged: ${stopped}`], trigger: opts.trigger ?? opts.mode, gateMode, evaluatedAt, fork: t.fork, posted: null });
      continue;
    }
    let headSha = t.headSha;
    let fork = t.fork;
    if (!headSha) {
      let pull;
      try {
        pull = io.pull(t.pr);
      } catch (err) {
        if (!(err instanceof BudgetError)) throw err;
        stopped = 'API budget for this run spent';
        records.push({ pr: t.pr, head: null, mainTip, verdict: 'unknown', reasons: [`not judged: ${stopped}`], trigger: opts.trigger ?? opts.mode, gateMode, evaluatedAt, fork, posted: null });
        continue;
      }
      headSha = pull.head.sha;
      fork = pull.head.repo?.full_name !== repo;
    }
    const rec = { ...evaluatePr(io, { pr: t.pr, headSha, mainTip, ceilings, globs, measured: t.measured ?? null, prRun: opts.prRun ?? null }), trigger: opts.trigger ?? opts.mode, gateMode, evaluatedAt };
    // A verdict the budget cut short is no answer: post nothing, keep the
    // head's old status, and stop the sweep before it spends more.
    const budgetCut = rec.budget === true;
    if (budgetCut) stopped = 'API budget for this run spent';
    let status = null;
    if (!fork && !opts.dryRun && !budgetCut) {
      try {
        // Shadow reads the existing status only where `on` may have left a
        // non-success: always for a single PR; in a sweep, for every head on
        // the first complete sweep after the gate left `on`, then for heads
        // this workflow last posted a non-success on, and for heads whose own
        // Test run judged with the gate `on` (those posts are not in this
        // cache: a brief `on` between two sweeps leaves only that trace).
        // A settled shadow sweep reads no statuses at all.
        const leftOn = cache?.lastMode !== 'shadow';
        const mayHold = opts.mode !== 'sweep' || leftOn || onHeads === null || onHeads.has(headSha) ||
          (io.store.posted[headSha] && io.store.posted[headSha] !== 'success');
        const existing = gateMode === 'on' || !mayHold ? null : io.existingStatus(headSha, STATUS_CONTEXT);
        status = statusFor(rec, gateMode, existing);
        if (status) io.postStatus(headSha, STATUS_CONTEXT, status, targetUrl);
      } catch (err) {
        console.log(`::warning title=base-stale::could not read or post the ${STATUS_CONTEXT} status on #${t.pr}: ${err.message.split('\n')[0]}`);
        status = { state: 'not-posted', description: err.message.split('\n')[0] };
        complete = false;
      }
    }
    records.push({ ...rec, fork, posted: status });
  }
  if (stopped) complete = false;
  if (stopped) console.log(`::notice title=base-stale::stopped early: ${stopped}; the rest are logged as not judged`);
  const lastMode = sweep && complete && !opts.dryRun ? gateMode : (cache?.lastMode ?? null);
  saveCache(opts.cache, io.store, sweep ? new Set(records.map((r) => r.head).filter(Boolean)) : null, lastMode);
  finish(opts, records, { gateMode, mainTip, evaluatedAt, stats: io.stats, allowance });
  return 0;
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = run(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`base-stale: ${err.message}`);
    process.exitCode = 2;
  }
}
