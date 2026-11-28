/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * I/O for `scripts/ci-base-stale.mjs`: GitHub API reads, artifact downloads
 * and local git. Every read either returns data or throws; "the API returned
 * nothing" is never turned into "there is nothing" here. A lookup that finds
 * no artifact returns null, which the decision core reads as `unknown`.
 *
 * API BUDGET. The workflow token shares 1,000 requests/hour per repository
 * with every other workflow, so the reads are frugal and counted (`calls`):
 * main's measurements are found by tree through the `tested-tree-<tree>`
 * artifact test.yml already uploads (no build, no search over runs), and an
 * optional cache (`cache`) keeps immutable answers across sweeps: a main
 * tree's measurement never changes, and a PR head's measurement only changes
 * when a newer run on that head measures again. Every counted call also
 * spends a per-run allowance (`setBudget`); past it, the call throws
 * `BudgetError` instead of reaching the API, so a busy day cannot drain the
 * token the other workflows share.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMeasuredFile, validateCeilingFile } from '../perf-ratchet/ceilings.mjs';
import { createDiffReaders } from './base-stale-diffs.mjs';
import { gh } from './gh.mjs';

export { changedPaths, compareMoved } from './base-stale-diffs.mjs';

export const MEASURED_ARTIFACTS = ['perf-ratchet-measured', 'perf-ratchet-measured-native'];
/**
 * Legacy marker emitted by enforcement builds before posting an in-run
 * status. Shadow rollback still reads existing artifacts with this name.
 */
export const IN_RUN_ON_ARTIFACT = 'base-stale-in-run-on';
/** `gh pr list --limit` for the sweep's candidates; a full page is reported as capped. */
export const CANDIDATE_LIMIT = 200;
/** Pages of in-run `on` markers read (100 each) before the lookup gives up and every head is read. */
const ON_MARKER_PAGES = 5;
const NEGATIVE_TTL_MS = 2 * 60 * 60 * 1000;
/** Runs tried per tree: a tree with no measuring run among its newest few is a miss, not a scan. */
const TREE_RUN_CAP = 5;

/** A read refused because this run has spent its API allowance. */
/** Largest measured file read from an artifact; real ones are a few KB. */
export const MEASURED_FILE_MAX_BYTES = 1024 * 1024;

/**
 * The `.json` files an unzipped artifact holds, each a regular file under the
 * size cap. A PR run (a fork's included) uploads these artifacts itself, so a
 * symlink (to /dev/zero, or to a file on the runner) or a huge file is refused
 * instead of followed: the throw makes that PR's verdict `unknown`.
 */
export function measuredJsonFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error(`artifact file ${name} is not a regular file`);
    if (st.size > MEASURED_FILE_MAX_BYTES) throw new Error(`artifact file ${name} is ${st.size} bytes, over the ${MEASURED_FILE_MAX_BYTES} cap`);
    files.push(path);
  }
  return files;
}

export class BudgetError extends Error {
  constructor(what) {
    super(`API budget for this run spent before ${what}`);
    this.name = 'BudgetError';
  }
}

/**
 * A run of THIS repository's code. A fork's `pull_request` run executes the
 * fork's workflow, so it can upload a `tested-tree-<tree>` artifact naming any
 * tree with any values (the same check as `isGreenBatchRun` in
 * ci-push-replay.mjs). Main's measurements are shared by every PR's verdict
 * and cached, so only a same-repository run may supply one.
 */
export function isOwnRun(workflowRun) {
  return Boolean(workflowRun?.id) && workflowRun.repository_id !== undefined && workflowRun.head_repository_id === workflowRun.repository_id;
}

/**
 * The first complete measurement among a tree's candidate runs (newest
 * first), else the first partial one. The native job uploads after the
 * bundle one and some runs never upload it, so a newer bundle-only run must
 * not hide an older run that measured both. `measure(runId)` returns the
 * run's families or null; `need` is how many make a complete measurement.
 */
export function pickTreeMeasurement(runIds, measure, need) {
  let partial = null;
  for (const runId of runIds) {
    const families = measure(runId);
    if (!families) continue;
    if (families.length >= need) return { families, runId, full: true };
    partial ??= { families, runId, full: false };
  }
  return partial;
}

/** `gh pr list` output to the sweep's candidates; a list at the limit may hide more. */
export function candidateList(raw, limit = CANDIDATE_LIMIT) {
  return { prs: raw.filter((p) => !p.isDraft), capped: raw.length >= limit };
}

/** Only what the decision reads, so the cross-sweep cache stays small. */
export function slim(measured) {
  return { family: measured.family, commit: measured.commit, metrics: measured.metrics.map((m) => ({ id: m.id, value: m.value })) };
}

export function createIo({ repo, cwd = process.cwd(), cache = null, now = () => Date.now(), gh: ghCall = gh, spawn = spawnSync }) {
  const stats = { calls: 0, downloads: 0, cacheHits: 0 };
  const store = { mainMeasurements: {}, prMeasurements: {}, prFiles: {}, posted: {}, released: {}, ...(cache ?? {}) };
  let budget = Infinity;

  /** Count one request against this run's allowance, or refuse it. */
  const spend = (what) => {
    if (stats.calls >= budget) throw new BudgetError(what);
    stats.calls += 1;
  };
  const api = (path, what) => {
    spend(what);
    return ghCall(['api', path], what);
  };
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  const haveCommit = (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, stdio: 'ignore' }).status === 0;

  /** Measured files attributable to the completed attempt, or null without its bundle. */
  function runMeasurement(runId, run = api(`repos/${repo}/actions/runs/${runId}`, `run ${runId}`)) {
    const attempt = run.run_attempt;
    if (run.status !== 'completed' || !Number.isSafeInteger(attempt) || attempt < 1) return null;
    // The artifact API scopes by run ID only. Use the attempt endpoint for
    // reruns, then exclude timestamps at either second-resolution boundary.
    const window = attempt === 1 ? run : api(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}`, `attempt ${attempt} of run ${runId}`);
    const start = Date.parse(window.run_started_at);
    const end = Date.parse(window.updated_at);
    if (window.run_attempt !== attempt || window.status !== 'completed' || !(start < end)) return null;
    const list = api(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`, `artifacts of run ${runId}`);
    const artifacts = list.artifacts ?? [];
    if ((list.total_count ?? Infinity) > artifacts.length) return null;
    const byName = new Map();
    for (const name of MEASURED_ARTIFACTS) {
      const matches = artifacts.filter((a) => a.name === name && !a.expired)
        .map((artifact) => ({ artifact, created: Date.parse(artifact.created_at) }))
        .filter(({ created }) => !(created < start || created > end));
      const [match] = matches;
      if (matches.length === 1 && match.created > start && match.created < end) byName.set(name, match.artifact);
    }
    if (!byName.has(MEASURED_ARTIFACTS[0])) return null;
    const dir = mkdtempSync(join(tmpdir(), 'base-stale-'));
    try {
      const families = [];
      for (const name of MEASURED_ARTIFACTS) {
        const art = byName.get(name);
        if (!art) continue;
        spend(`artifact ${name} of run ${runId}`);
        stats.downloads += 1;
        const zip = spawn('gh', ['api', `repos/${repo}/actions/artifacts/${art.id}/zip`], { maxBuffer: 64 * 1024 * 1024 });
        if (zip.status !== 0) throw new Error(`downloading artifact ${name} of run ${runId} failed: ${String(zip.stderr).trim()}`);
        const out = join(dir, name);
        mkdirSync(out);
        writeFileSync(join(dir, `${name}.zip`), zip.stdout);
        execFileSync('unzip', ['-q', '-o', join(dir, `${name}.zip`), '-d', out]);
        const family = name === MEASURED_ARTIFACTS[0] ? 'bundle' : 'native-instructions';
        const matches = measuredJsonFiles(out).map(loadMeasuredFile).filter((m) => m.family === family);
        if (matches.length !== 1 && family === 'bundle') return null;
        if (matches.length === 1 && (!families.length || matches[0].commit === families[0].commit)) families.push(slim(matches[0]));
      }
      return families;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function treeOf(sha) {
    if (haveCommit(sha)) return git(['rev-parse', `${sha}^{tree}`]);
    return api(`repos/${repo}/git/commits/${sha}`, `commit ${sha}`).tree.sha;
  }

  function mainMeasurementAt(sha) {
    const tree = treeOf(sha);
    const hit = store.mainMeasurements[tree];
    // A miss or partial measurement expires. A full tree match is final.
    if (hit?.attemptScoped && ((hit.families && !hit.checkedAt) || now() - hit.checkedAt < NEGATIVE_TTL_MS)) {
      stats.cacheHits += 1;
      return hit.families ? { sha, families: hit.families, runId: hit.runId } : null;
    }
    const found = api(`repos/${repo}/actions/artifacts?name=tested-tree-${tree}&per_page=20`, `the tested-tree artifact of ${sha}`);
    const candidates = (found.artifacts ?? [])
      .filter((a) => !a.expired && isOwnRun(a.workflow_run))
      .sort((a, b) => b.id - a.id)
      .slice(0, TREE_RUN_CAP);
    const measureTree = (id) => {
      const families = runMeasurement(id);
      return families && treeOf(families[0].commit) === tree ? families : null;
    };
    const picked = pickTreeMeasurement(candidates.map((a) => a.workflow_run.id), measureTree, MEASURED_ARTIFACTS.length);
    if (!picked) {
      store.mainMeasurements[tree] = { attemptScoped: true, families: null, checkedAt: now() };
      return null;
    }
    store.mainMeasurements[tree] = { attemptScoped: true, families: picked.families, runId: picked.runId, ...(picked.full ? {} : { checkedAt: now() }) };
    return { sha, families: picked.families, runId: picked.runId };
  }
  /** First-parent history of main from `tip`, newest first. */
  function mainHistory(tip, count) {
    if (haveCommit(tip)) return git(['rev-list', '--first-parent', `-n${count}`, tip]).split('\n').filter(Boolean);
    return api(`repos/${repo}/commits?sha=${tip}&per_page=${count}`, `main's history from ${tip}`).map((c) => c.sha);
  }

  /** The newest measured main commit within `maxBack` of the tip. */
  function latestMainMeasurement(tip, maxBack = 10) {
    const history = mainHistory(tip, maxBack);
    for (let i = 0; i < history.length; i += 1) {
      const m = mainMeasurementAt(history[i]);
      if (m) return { ...m, behindTip: i };
    }
    return null;
  }

  /** Base and head of a `pull_request` merge commit; null when it is not one. */
  function mergeParents(mergeSha, headSha) {
    const parents = api(`repos/${repo}/commits/${mergeSha}`, `merge commit ${mergeSha}`).parents?.map((p) => p.sha) ?? [];
    if (parents.length !== 2 || (headSha && parents[1] !== headSha)) return null;
    return parents[0];
  }

  /**
   * The PR head's newest measurement: the newest `pull_request` Test run on
   * that head that uploaded one. Older runs on the same head are not skipped
   * past a newer measuring run, so a re-run with a newer base wins. Two PRs
   * can share a head against different bases, so a run that names its PRs
   * must name this one (a fork's run names none and is taken as is), and the
   * cache is keyed by PR as well as head.
   */
  function prMeasurement(headSha, onlyRun = null, number = null) {
    if (onlyRun) {
      const families = runMeasurement(onlyRun);
      if (!families) return null;
      // A replay names a past run, whose head is not the PR's current one.
      return { runId: onlyRun, mergeSha: families[0].commit, testedBase: mergeParents(families[0].commit, null), families };
    }
    const runs = api(
      `repos/${repo}/actions/workflows/test.yml/runs?head_sha=${headSha}&event=pull_request&per_page=20`,
      `Test runs on ${headSha}`,
    ).workflow_runs ?? [];
    const forThisPr = (r) => number === null || !(r.pull_requests?.length) || r.pull_requests.some((p) => p.number === number);
    const own = runs
      .filter((r) => !String(r.head_branch ?? '').startsWith('mergify/merge-queue/') && forThisPr(r))
      .sort((a, b) => b.id - a.id);
    const key = number === null ? headSha : `${headSha}#${number}`;
    const cached = store.prMeasurements[key];
    for (const run of own) {
      if (run.status !== 'completed') continue;
      // GitHub reuses the run ID on reruns. Legacy entries have no attempt.
      const runAttempt = run.run_attempt;
      const knownAttempt = Number.isSafeInteger(runAttempt) && runAttempt > 0;
      if (knownAttempt && cached?.runId === run.id && cached.runAttempt === runAttempt) {
        stats.cacheHits += 1;
        return cached;
      }
      const families = runMeasurement(run.id, run);
      if (!families) {
        if (runAttempt !== 1) return null;
        continue;
      }
      const mergeSha = families[0].commit;
      const testedBase = mergeParents(mergeSha, headSha);
      const entry = { runId: run.id, runAttempt, mergeSha, testedBase, families };
      if (knownAttempt) store.prMeasurements[key] = entry;
      return entry;
    }
    return null;
  }

  /** Current main's ceiling files, family -> validated file. */
  function ceilingsAt(tip) {
    const out = new Map();
    const read = (name, text) => {
      const data = JSON.parse(text);
      const problems = validateCeilingFile(data);
      if (problems.length) throw new Error(`ceiling file ${name} at ${tip} is invalid: ${problems.join('; ')}`);
      out.set(data.family, data);
    };
    if (haveCommit(tip)) {
      // The trailing slash lists the directory's entries, not the directory.
      for (const p of git(['ls-tree', '--name-only', tip, 'tests/perf-ratchets/']).split('\n').filter((n) => n.endsWith('.json'))) {
        read(p, git(['show', `${tip}:${p}`]));
      }
    } else {
      const dir = api(`repos/${repo}/contents/tests/perf-ratchets?ref=${tip}`, `ceiling files at ${tip}`);
      for (const f of dir.filter((e) => e.name.endsWith('.json'))) {
        const file = api(`repos/${repo}/contents/${f.path}?ref=${tip}`, `${f.path} at ${tip}`);
        read(f.path, Buffer.from(file.content, 'base64').toString('utf8'));
      }
    }
    if (out.size === 0) throw new Error(`no ceiling files under tests/perf-ratchets/ at ${tip}`);
    return out;
  }

  function pull(number) {
    return api(`repos/${repo}/pulls/${number}`, `PR #${number}`);
  }

  function mainTip() {
    return api(`repos/${repo}/commits/main`, "main's tip").sha;
  }

  /** This context's state on a commit, or null when absent. */
  function existingStatus(sha, context) {
    const combined = api(`repos/${repo}/commits/${sha}/status?per_page=100`, `statuses on ${sha}`);
    const statuses = combined.statuses ?? [];
    const found = statuses.find((s) => s.context === context)?.state ?? null;
    // Not on a page that holds every context is no answer, not "absent".
    if (found === null && (combined.total_count ?? 0) > statuses.length) throw new Error(`${sha} has ${combined.total_count} statuses; ${context} is not on the first page`);
    return found;
  }

  function postStatus(sha, context, { state, description }, targetUrl) {
    const args = ['api', '--method', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description}`];
    if (targetUrl) args.push('-f', `target_url=${targetUrl}`);
    spend(`the ${context} status on ${sha}`);
    ghCall(args, `the ${context} status on ${sha}`);
    store.posted[sha] = state;
  }

  /**
   * Open, labelled, non-draft PRs on main, with their head SHA. `capped`:
   * the list reached the limit, so a PR may be missing from it and the
   * sweep that read it is not complete (see saveCache in ci-base-stale.mjs).
   */
  function queueCandidates(label) {
    spend(`open PRs labelled ${label}`);
    const list = ghCall(
      ['pr', 'list', '--repo', repo, '--label', label, '--state', 'open', '--base', 'main', '--limit', String(CANDIDATE_LIMIT), '--json', 'number,headRefOid,isDraft,isCrossRepository'],
      `open PRs labelled ${label}`,
    );
    return candidateList(list);
  }

  /**
   * PR heads whose own Test run judged with the gate `on`: that step posts
   * statuses this workflow's cache never sees, so they are the heads a shadow
   * sweep must read to release (test.yml uploads the marker before it can
   * post). Paged, 100 per call, at most ON_MARKER_PAGES pages; a set that
   * may be missing markers throws, and the caller then reads every head.
   * Only this repository's runs count.
   */
  function inRunOnHeads() {
    const heads = new Set();
    let seen = 0;
    for (let page = 1; ; page += 1) {
      const found = api(`repos/${repo}/actions/artifacts?name=${IN_RUN_ON_ARTIFACT}&per_page=100&page=${page}`, 'the in-run markers of the gate on');
      const arts = found.artifacts ?? [];
      seen += arts.length;
      for (const a of arts) if (isOwnRun(a.workflow_run) && a.workflow_run.head_sha) heads.add(a.workflow_run.head_sha);
      const total = found.total_count ?? seen;
      if (seen >= total || arts.length < 100) {
        if (seen < total) throw new Error(`listed ${seen} of ${total} in-run markers`);
        return heads;
      }
      if (page >= ON_MARKER_PAGES) throw new Error(`more than ${seen} in-run markers; not all were read`);
    }
  }

  function coreRemaining() {
    // `rate_limit` does not count against the limit it reports.
    return ghCall(['api', 'rate_limit'], 'the API rate limit').resources?.core?.remaining ?? null;
  }

  /** Cap this run's counted calls (including those already made). */
  function setBudget(n) {
    budget = n;
  }

  const { movedSince, prFiles } = createDiffReaders({ repo, cwd, api, git, haveCommit, pull, prFileCache: store.prFiles, stats });
  return {
    stats,
    store,
    setBudget,
    pull,
    mainTip,
    mainMeasurementAt,
    latestMainMeasurement,
    mergeParents,
    prMeasurement,
    movedSince,
    prFiles,
    ceilingsAt,
    existingStatus,
    postStatus,
    queueCandidates,
    coreRemaining,
    inRunOnHeads,
  };
}
