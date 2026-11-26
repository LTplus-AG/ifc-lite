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
import { gh } from './gh.mjs';

export const MEASURED_ARTIFACTS = ['perf-ratchet-measured', 'perf-ratchet-measured-native'];
/** test.yml's upload of an in-run verdict judged with CI_BASE_STALE_GATE=on. */
export const IN_RUN_ON_ARTIFACT = 'base-stale-verdicts-pr-run-on';
const NEGATIVE_TTL_MS = 2 * 60 * 60 * 1000;
const COMPARE_FILE_CAP = 300;
const COMPARE_COMMIT_CAP = 250;
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
 * A `compare` response to main's moved paths. `compare` caps files at 300 and
 * drops them past 250 commits: that is reported as capped, never as "nothing
 * moved". The cap counts entries, not the two paths a rename expands to.
 */
export function compareMoved(cmp) {
  const capped = !cmp.files || cmp.files.length >= COMPARE_FILE_CAP || cmp.total_commits >= COMPARE_COMMIT_CAP;
  return { files: cmp.files ? changedPaths(cmp.files) : [], commits: cmp.total_commits, capped };
}

/** `pulls/<n>/files` entries to paths: a rename counts at both ends, or a move out of a crate hides it. */
export function changedPaths(entries) {
  return entries.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
}

/** Only what the decision reads, so the cross-sweep cache stays small. */
export function slim(measured) {
  return { family: measured.family, commit: measured.commit, metrics: measured.metrics.map((m) => ({ id: m.id, value: m.value })) };
}

export function createIo({ repo, cwd = process.cwd(), cache = null, now = () => Date.now() }) {
  const stats = { calls: 0, downloads: 0, cacheHits: 0 };
  const store = { mainMeasurements: {}, prMeasurements: {}, prFiles: {}, posted: {}, ...(cache ?? {}) };
  let budget = Infinity;

  /** Count one request against this run's allowance, or refuse it. */
  const spend = (what) => {
    if (stats.calls >= budget) throw new BudgetError(what);
    stats.calls += 1;
  };
  const api = (path, what) => {
    spend(what);
    return gh(['api', path], what);
  };
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  const haveCommit = (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, stdio: 'ignore' }).status === 0;

  /** Measured files in a run's perf-ratchet artifacts, or null without the bundle one. */
  function runMeasurement(runId) {
    const list = api(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`, `artifacts of run ${runId}`);
    const byName = new Map((list.artifacts ?? []).filter((a) => !a.expired).map((a) => [a.name, a]));
    if (!byName.has(MEASURED_ARTIFACTS[0])) return null;
    const dir = mkdtempSync(join(tmpdir(), 'base-stale-'));
    try {
      const families = [];
      for (const name of MEASURED_ARTIFACTS) {
        const art = byName.get(name);
        if (!art) continue;
        spend(`artifact ${name} of run ${runId}`);
        stats.downloads += 1;
        const zip = spawnSync('gh', ['api', `repos/${repo}/actions/artifacts/${art.id}/zip`], { maxBuffer: 64 * 1024 * 1024 });
        if (zip.status !== 0) throw new Error(`downloading artifact ${name} of run ${runId} failed: ${String(zip.stderr).trim()}`);
        const out = join(dir, name);
        mkdirSync(out);
        writeFileSync(join(dir, `${name}.zip`), zip.stdout);
        execFileSync('unzip', ['-q', '-o', join(dir, `${name}.zip`), '-d', out]);
        for (const f of measuredJsonFiles(out)) families.push(slim(loadMeasuredFile(f)));
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

  /** Main's measurement at one commit, found by tree, or null. */
  function mainMeasurementAt(sha) {
    const tree = treeOf(sha);
    const hit = store.mainMeasurements[tree];
    // A miss, or a measurement without every family (the native job uploads
    // after the bundle one), is re-checked after the TTL; a full one is final.
    if (hit && ((hit.families && !hit.checkedAt) || now() - hit.checkedAt < NEGATIVE_TTL_MS)) {
      stats.cacheHits += 1;
      return hit.families ? { sha, families: hit.families, runId: hit.runId } : null;
    }
    const found = api(`repos/${repo}/actions/artifacts?name=tested-tree-${tree}&per_page=20`, `the tested-tree artifact of ${sha}`);
    const candidates = (found.artifacts ?? [])
      .filter((a) => !a.expired && isOwnRun(a.workflow_run))
      .sort((a, b) => b.id - a.id)
      .slice(0, TREE_RUN_CAP);
    for (const art of candidates) {
      const families = runMeasurement(art.workflow_run.id);
      if (families) {
        const full = families.length >= MEASURED_ARTIFACTS.length;
        store.mainMeasurements[tree] = { families, runId: art.workflow_run.id, ...(full ? {} : { checkedAt: now() }) };
        return { sha, families, runId: art.workflow_run.id };
      }
    }
    store.mainMeasurements[tree] = { families: null, checkedAt: now() };
    return null;
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
      if (cached && cached.runId === run.id) {
        stats.cacheHits += 1;
        return cached;
      }
      if (run.status !== 'completed') continue;
      const families = runMeasurement(run.id);
      if (!families) continue;
      const mergeSha = families[0].commit;
      const testedBase = mergeParents(mergeSha, headSha);
      const entry = { runId: run.id, mergeSha, testedBase, families };
      store.prMeasurements[key] = entry;
      return entry;
    }
    return null;
  }

  /** Main's changed files since `base`: local git when both ends are present, else `compare`. */
  function movedSince(base, tip) {
    if (haveCommit(base) && haveCommit(tip)) {
      // A base that is not behind the tip (a replay against an older main)
      // would give a reversed diff: that is no answer, not an empty one.
      if (spawnSync('git', ['merge-base', '--is-ancestor', base, tip], { cwd }).status !== 0) return null;
      // --no-renames: a move lists its old path too (a crate main moved a file
      // out of still changed), and rename detection would fetch blobs.
      // -z: raw path bytes, not C-quoted ones a non-ASCII name would get.
      const files = git(['diff', '--name-only', '-z', '--no-renames', `${base}..${tip}`]).split('\0').filter(Boolean);
      const commits = Number(git(['rev-list', '--count', `${base}..${tip}`]));
      return { files, commits, capped: false };
    }
    const cmp = api(`repos/${repo}/compare/${base}...${tip}`, `main's changes since ${base}`);
    if (cmp.status !== 'ahead' && cmp.status !== 'identical') return null;
    return compareMoved(cmp);
  }

  /**
   * The PR's changed files (REST, paginated; GitHub stops at 3,000), with a
   * renamed file's old path too. Cached per head SHA: a head's diff against
   * its merge base does not change. Counted as one call per page.
   */
  function prFiles(number, headSha = null) {
    // Keyed by PR and head: two PRs can share a head against different bases.
    const key = headSha ? `${headSha}#${number}` : null;
    if (key && store.prFiles[key]) {
      stats.cacheHits += 1;
      return store.prFiles[key];
    }
    const files = [];
    for (let page = 1; ; page += 1) {
      const entries = api(`repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, `files of PR #${number}`);
      files.push(...changedPaths(entries));
      if (entries.length < 100) break;
      // GitHub lists at most 3,000 files: a full 30th page may hide the rest,
      // and a prefix read as the whole list could call a Rust PR not relevant.
      if (page >= 30) throw new Error(`PR #${number} changes 3,000+ files; GitHub does not list them all`);
    }
    if (key) store.prFiles[key] = files;
    return files;
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
    gh(args, `the ${context} status on ${sha}`);
    store.posted[sha] = state;
  }

  /** Open, labelled, non-draft PRs on main, with their head SHA. */
  function queueCandidates(label) {
    spend(`open PRs labelled ${label}`);
    const list = gh(
      ['pr', 'list', '--repo', repo, '--label', label, '--state', 'open', '--base', 'main', '--limit', '200', '--json', 'number,headRefOid,isDraft,isCrossRepository'],
      `open PRs labelled ${label}`,
    );
    return list.filter((p) => !p.isDraft);
  }

  /**
   * PR heads whose own Test run judged with the gate `on`: that step posts
   * statuses this workflow's cache never sees, so they are the heads a shadow
   * sweep must read to release (test.yml names the upload after the mode).
   * One call, newest 100; only this repository's runs.
   */
  function inRunOnHeads() {
    const found = api(`repos/${repo}/actions/artifacts?name=${IN_RUN_ON_ARTIFACT}&per_page=100`, 'the in-run verdicts posted with the gate on');
    return new Set((found.artifacts ?? []).filter((a) => isOwnRun(a.workflow_run) && a.workflow_run.head_sha).map((a) => a.workflow_run.head_sha));
  }

  function coreRemaining() {
    // `rate_limit` does not count against the limit it reports.
    return gh(['api', 'rate_limit'], 'the API rate limit').resources?.core?.remaining ?? null;
  }

  /** Cap this run's counted calls (including those already made). */
  function setBudget(n) {
    budget = n;
  }

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
