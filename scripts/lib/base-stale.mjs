/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure core of the base-stale signal (`scripts/ci-base-stale.mjs`). No I/O:
 * every function here takes plain data, so the verdict is unit-testable and
 * replayable over recorded history.
 *
 * THE QUESTION. A PR's checks ran against the main it was merged with at the
 * time. Main has moved since. Would the PR's last relevant result still hold
 * on current main? Two gates are judged, because merge-queue reds keep
 * landing on them after main moved (queue runs 45001383910 and 45039295698
 * were 50-360 B over `bundle/viewer-eager-js-bytes`):
 *
 *  - PERF RATCHET. The PR's measured values are projected onto current main:
 *    `projected = pr + (mainLatest - mainAtBase)`, per metric, where
 *    `mainAtBase` is main's measurement at the base the PR was measured on.
 *    The projection is judged against CURRENT main's ceilings with the same
 *    `allowedMax` the ratchet uses. A PR value that is already above current
 *    main's allowance (a ceiling was lowered since) is stale without any
 *    drift. Nothing is rebuilt: the inputs are artifacts CI already uploaded.
 *  - RUST. A cheap signal, not a re-run: main changed Rust inputs since the
 *    PR's tested base in a scope the PR also changed (same crate directory,
 *    or both changed workspace files such as Cargo.lock). Both tiers are recorded
 *    (`mainRustFiles` for "any Rust moved", `overlap` for the scoped one) so
 *    the shadow period can measure which one predicts queue reds.
 *
 * NEVER PASS BY ABSENCE. A missing artifact, an unreadable base, a capped
 * diff: each is `unknown`, which is advisory and is never reported as fresh.
 * `not-relevant` is only ever derived from the PR's own file list matched
 * against the same path filters test.yml uses, i.e. positive evidence.
 */

import { allowedMax } from '../perf-ratchet/compare.mjs';
import { matchesAny } from './ci-path-coverage.mjs';

export const STALE = 'stale';
export const UNKNOWN = 'unknown';
export const FRESH = 'fresh';
export const NOT_RELEVANT = 'not-relevant';

/** Worst first: the combined verdict is the first of these any part reports. */
const SEVERITY = [STALE, UNKNOWN, FRESH, NOT_RELEVANT];

/** The commit status context the `on` mode posts on the PR head. */
export const STATUS_CONTEXT = 'PR base staleness';

/** The label Mergify queues on; the sweep evaluates PRs that carry it. */
export const QUEUE_LABEL = 'mergify-trial';

/** GitHub caps a commit status description at 140 characters. */
const DESCRIPTION_MAX = 140;

/**
 * `CI_BASE_STALE_GATE`: exactly `on` enforces (posts the status). Anything
 * else, unset and typos included, is `shadow`, the advisory direction.
 */
export function parseGateMode(raw) {
  return String(raw ?? '').trim() === 'on' ? 'on' : 'shadow';
}

/**
 * Which of the two gates the PR's diff can move, from the PR's file list and
 * test.yml's own `dorny/paths-filter` globs.
 *
 * @param {string[]} prFiles repo-relative paths the PR changes
 * @param {{ perfGlobs: string[], rustGlobs: string[] }} globs perfGlobs is the
 *   union of the filters that gate the `perf-ratchet` job; rustGlobs the `rust` filter
 */
export function prRelevance(prFiles, { perfGlobs, rustGlobs }) {
  if (!Array.isArray(prFiles)) throw new Error('prRelevance: prFiles must be an array');
  if (!perfGlobs?.length || !rustGlobs?.length) {
    // An empty glob list would read every PR as not relevant: pass by absence.
    throw new Error('prRelevance: empty filter globs');
  }
  return {
    perf: prFiles.some((f) => matchesAny(f, perfGlobs)),
    rust: prFiles.some((f) => matchesAny(f, rustGlobs)),
    editsCeilings: prFiles.some((f) => f.startsWith('tests/perf-ratchets/')),
  };
}

function short(sha) {
  return sha ? String(sha).slice(0, 9) : '?';
}

function metricMap(families) {
  const out = new Map();
  for (const fam of families ?? []) {
    for (const m of fam.metrics ?? []) out.set(`${fam.family}/${m.id}`, m.value);
  }
  return out;
}

/**
 * Perf-ratchet half.
 *
 * @param {object} input
 * @param {boolean} input.relevant  from prRelevance().perf
 * @param {boolean} [input.editsCeilings]
 * @param {Array<object>|null} input.prMeasured  validated measured files from the PR's run, null when not found
 * @param {string|null} input.testedBase  main commit the PR was measured on
 * @param {Map<string, object>} input.ceilings  family -> validated ceiling file, read from current main
 * @param {{ sha: string, families: Array<object> }|null} input.mainAtBase  main's measurement at testedBase
 * @param {{ sha: string, behindTip: number, families: Array<object> }|null} input.mainLatest  newest measured main commit
 */
export function evaluatePerf({ relevant, editsCeilings = false, prMeasured, testedBase, ceilings, mainAtBase, mainLatest }) {
  if (!relevant) return { verdict: NOT_RELEVANT, reasons: ['PR changes no perf-ratchet input'], rows: [] };
  if (!prMeasured || prMeasured.length === 0) {
    return { verdict: UNKNOWN, reasons: ["no perf-ratchet measurement found for the PR's head"], rows: [] };
  }
  if (editsCeilings) {
    // The merged tree's ceilings are main's with this PR's edits on top, not
    // main's: judging against main's alone would be a confident wrong answer.
    return { verdict: UNKNOWN, reasons: ['PR edits tests/perf-ratchets/; its merged ceilings are not main\'s'], rows: [] };
  }
  const atBase = mainAtBase ? metricMap(mainAtBase.families) : null;
  const latest = mainLatest ? metricMap(mainLatest.families) : null;
  const rows = [];
  for (const fam of prMeasured) {
    const ceilingFile = ceilings.get(fam.family);
    if (!ceilingFile) {
      rows.push({ id: `${fam.family}/*`, verdict: UNKNOWN, reason: `main has no ceiling file for family \`${fam.family}\`` });
      continue;
    }
    const prById = new Map(fam.metrics.map((m) => [m.id, m.value]));
    for (const entry of ceilingFile.entries) {
      const id = `${fam.family}/${entry.id}`;
      const allowed = allowedMax(entry);
      const pr = prById.get(entry.id);
      const base = { id, ceiling: entry.ceiling, allowed, pr: pr ?? null, drift: null, projected: null };
      if (pr === undefined) {
        rows.push({ ...base, verdict: UNKNOWN, reason: `${id}: main has a ceiling the PR's run did not measure` });
        continue;
      }
      if (pr > allowed) {
        rows.push({
          ...base,
          verdict: STALE,
          reason: `${id}: PR measured ${pr} on ${short(testedBase)}, above current main's allowance ${allowed} (ceiling ${entry.ceiling})`,
        });
        continue;
      }
      const b = atBase?.get(id);
      const l = latest?.get(id);
      if (b === undefined || l === undefined) {
        const what = !mainAtBase ? `main at the PR's base ${short(testedBase)}` : !mainLatest ? 'recent main' : `this metric on main`;
        rows.push({ ...base, verdict: UNKNOWN, reason: `${id}: no measurement of ${what}, main's drift is unmeasured` });
        continue;
      }
      const drift = l - b;
      const projected = pr + drift;
      const row = { ...base, drift, projected };
      if (projected > allowed) {
        rows.push({
          ...row,
          verdict: STALE,
          reason:
            `${id}: PR ${pr} on ${short(testedBase)}, main ${drift >= 0 ? '+' : ''}${drift} since (to ${short(mainLatest.sha)}); ` +
            `projected ${projected} > allowed ${allowed} by ${projected - allowed}`,
        });
      } else {
        const note = projected > entry.ceiling ? 'within tolerance' : 'at or under ceiling';
        rows.push({ ...row, verdict: FRESH, reason: `${id}: projected ${projected} <= allowed ${allowed}, ${allowed - projected} to spare (${note})` });
      }
    }
  }
  const verdict = worst(rows.map((r) => r.verdict)) ?? UNKNOWN;
  // Tightest first, so the first reason of a fresh verdict is the metric
  // closest to its allowance (the one to watch), not the first in the file.
  const headroom = (r) => (r.projected === null || r.projected === undefined ? Infinity : (r.allowed - r.projected) / Math.max(r.allowed, 1));
  const reasons = rows.filter((r) => r.verdict === verdict).sort((a, b) => headroom(a) - headroom(b)).map((r) => r.reason);
  if (rows.length === 0) reasons.push('the PR measurement matched no ceiling entry');
  if (verdict !== STALE && mainLatest?.behindTip > 0) {
    reasons.push(`main last measured at ${short(mainLatest.sha)}, ${mainLatest.behindTip} commit(s) behind its tip`);
  }
  return { verdict, reasons, rows };
}

/** Files every Rust crate builds against; they form the `workspace` scope. */
const WORKSPACE_RUST_FILES = new Set(['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo/config.toml']);

/**
 * The scope a Rust-relevant path compiles in: `rust/<crate>`, `apps/server`,
 * or `workspace` for the files every crate builds against. Anything else the
 * `rust` filter carries (test.yml itself, harness scripts, the CLI's retained
 * glue) re-triggers the Rust lanes but is not Rust source, so it has no scope
 * and never overlaps: two PRs both editing test.yml is not a Rust conflict.
 */
export function rustScope(path) {
  if (WORKSPACE_RUST_FILES.has(path)) return 'workspace';
  const parts = path.split('/');
  if (parts[0] === 'rust' && parts.length > 2) return `rust/${parts[1]}`;
  if (parts[0] === 'apps' && parts[1] === 'server' && parts.length > 2) return 'apps/server';
  return null;
}

/**
 * Rust half: did main change Rust inputs, since the PR's tested base, in a
 * scope the PR also changed?
 *
 * Deliberately NOT a dependency-graph analysis. A crate the PR changes and a
 * different crate main changed can still break each other through an API, and
 * this does not see that; `mainRustFiles` records the coarse "any Rust moved"
 * tier so the shadow period measures what the scoped tier misses.
 *
 * @param {object} input
 * @param {boolean} input.relevant  from prRelevance().rust
 * @param {string[]} input.prFiles
 * @param {string[]} input.rustGlobs
 * @param {string|null} input.testedBase
 * @param {{ files: string[], commits: number, capped: boolean }|null} input.moved  main's changes testedBase..tip
 */
export function evaluateRust({ relevant, prFiles, rustGlobs, testedBase, moved }) {
  if (!relevant) return { verdict: NOT_RELEVANT, reasons: ['PR changes no Rust input'], mainRustFiles: 0, overlap: [] };
  if (!testedBase) return { verdict: UNKNOWN, reasons: ["the PR's tested base is unknown"], mainRustFiles: null, overlap: [] };
  if (!moved) return { verdict: UNKNOWN, reasons: [`main's changes since ${short(testedBase)} could not be read`], mainRustFiles: null, overlap: [] };
  if (moved.capped) {
    return { verdict: UNKNOWN, reasons: [`main's diff since ${short(testedBase)} is too large to list (${moved.commits} commits)`], mainRustFiles: null, overlap: [] };
  }
  const mainRust = moved.files.filter((f) => matchesAny(f, rustGlobs));
  if (mainRust.length === 0) {
    return { verdict: FRESH, reasons: [`main changed no Rust input since ${short(testedBase)} (${moved.commits} commits)`], mainRustFiles: 0, overlap: [] };
  }
  const scopes = (files) => new Set(files.filter((f) => matchesAny(f, rustGlobs)).map(rustScope).filter(Boolean));
  const prScopes = scopes(prFiles);
  const mainScopes = scopes(mainRust);
  // `workspace` overlaps only `workspace`. Main touches Cargo.toml/Cargo.lock
  // on every release (the version bump), and counting that against every
  // crate would make the scoped tier the coarse one. A dependency bump that
  // breaks a crate is therefore left to the coarse tier and the queue.
  const overlap = [...prScopes].filter((s) => mainScopes.has(s));
  if (overlap.length > 0) {
    return {
      verdict: STALE,
      reasons: [`main changed ${mainRust.length} Rust file(s) in ${overlap.join(', ')} since ${short(testedBase)} (${moved.commits} commits), which the PR also changes`],
      mainRustFiles: mainRust.length,
      overlap,
    };
  }
  return {
    verdict: FRESH,
    reasons: [`main changed Rust only in ${[...mainScopes].join(', ') || 'non-source paths'} since ${short(testedBase)}; the PR changes ${[...prScopes].join(', ') || 'no Rust source'}`],
    mainRustFiles: mainRust.length,
    overlap: [],
  };
}

function worst(verdicts) {
  for (const v of SEVERITY) if (verdicts.includes(v)) return v;
  return null;
}

/** Combined verdict: the worst part wins; reasons come from the parts that set it. */
export function combine(perf, rust) {
  const verdict = worst([perf.verdict, rust.verdict]);
  const reasons = [];
  if (perf.verdict === verdict) reasons.push(...perf.reasons.map((r) => `perf: ${r}`));
  if (rust.verdict === verdict) reasons.push(...rust.reasons.map((r) => `rust: ${r}`));
  return { verdict, reasons };
}

function clip(text) {
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 1)}…`;
}

/**
 * What to post on the PR head.
 *
 * `on`: `stale` is a `failure` (Mergify's `-check-failure=` reads it); every
 * other verdict is `success`, its description saying which one. `unknown` is
 * advisory by design: it does not hold a PR, and it says "not judged" rather
 * than "fresh".
 *
 * `shadow` posts nothing, with one exception that makes the rollback a single
 * variable deletion: a non-success status of this context that an earlier `on`
 * run left on the head is overwritten with a success that says the gate is in
 * shadow. `existingState` is that status, or null when absent.
 *
 * @returns {{ state: 'success'|'failure', description: string } | null}
 */
export function statusFor({ verdict, reasons }, mode, existingState = null) {
  const first = reasons[0] ?? '';
  if (mode !== 'on') {
    if (existingState && existingState !== 'success') {
      return { state: 'success', description: clip('Gate in shadow (CI_BASE_STALE_GATE not on): not enforced') };
    }
    return null;
  }
  switch (verdict) {
    case STALE:
      return { state: 'failure', description: clip(`Would fail on current main: ${first.replace(/^(perf|rust): /, '')}`) };
    case UNKNOWN:
      return { state: 'success', description: clip(`Not judged (advisory): ${first.replace(/^(perf|rust): /, '')}`) };
    case FRESH:
      return { state: 'success', description: clip('Still holds on current main') };
    default:
      return { state: 'success', description: clip('No perf-ratchet or Rust input changed') };
  }
}

/** One Markdown line for the step summary, honest about when it was judged. */
export function summaryLine({ pr, verdict, reasons, mainTip, testedBase, trigger }) {
  const tag = verdict === STALE ? `would block: ${reasons[0] ?? ''}` : `${verdict}${reasons[0] ? `: ${reasons[0]}` : ''}`;
  return `- #${pr} (${trigger}, base ${short(testedBase)} vs main ${short(mainTip)}): ${tag}`;
}
