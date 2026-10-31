#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SILENT REVERT GUARD: fail a PR whose merge would put three or more files of
 * an already-merged commit back to their exact earlier bytes, unless the PR
 * says it means to. The rules and their measurements are in
 * `scripts/lib/silent-revert.mjs`; this file is the git side.
 *
 * ROOT CAUSE OF #8377 (705eb56357), because it decides what must be checked.
 * The branch was cut on #8360 itself (parent eaddb03505) and its FIRST commit,
 * d1f4fa346a, already carried the 14 files at their pre-#8360 blobs: the
 * working tree the commit was made from was stale for exactly the files
 * #8360 touched. Nothing about the merge produced it. GitHub's rebase onto a
 * later main, the squash and the test merge all reproduced it faithfully, and
 * the 22-file PR diff showed it in plain sight. So the discriminator is NOT
 * "the branch is stale": the PR's own diff restores old bytes of a commit that
 * was already on the base BEFORE the PR's merge base. That is why the window
 * is "the last N commits of the base" as well as "everything since the merge
 * base": #8360 sat below the merge base and a merge-base-only check misses it.
 *
 * WHAT IS EVALUATED. Never the head-vs-base two-dot diff. For a branch that
 * has fallen behind, that diff shows every file the base changed since as
 * "reverted" and flags innocent PRs. The tree evaluated is the one the merge
 * WILL produce: `git merge-tree --write-tree <base> <head>`, diffed against
 * the base tip.
 *
 * FAILS CLOSED (exit 2, never 0) when it cannot look: a shallow checkout whose
 * boundary falls inside the window, no merge base, a merge conflict, a git too
 * old for `merge-tree --write-tree`. A guard that passes having examined
 * nothing is the failure this repository keeps re-learning.
 *
 * USAGE
 *   node scripts/check-silent-revert.mjs [--base origin/main] [--head HEAD]
 *        [--window 100] [--min-files 3] [--title T] [--body B] [--label L]...
 *        [--scan <n>] [--json] [--root <dir>]
 *   --scan <n>  replay the n newest first-parent commits ending at --base, each
 *               as if it were a PR (its subject and body are its declaration).
 *               This is how "no false positive over the last 100 commits" is
 *               measured, and it exits 1 if any commit is flagged.
 *   Declarations default to PR_TITLE / PR_BODY / PR_LABELS (a JSON array), then
 *   to the head commit's own message for a local run.
 *
 * EXIT  0 clean or declared   1 silent revert   2 could not evaluate
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MIN_FILES,
  DEFAULT_WINDOW,
  applyDeclarations,
  findSilentReverts,
  formatFailure,
  parseDeclarations,
  parseRawDiffZ,
} from './lib/silent-revert.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

class Unevaluable extends Error {}

function makeGit(root) {
  return (args, { allowFail = false } = {}) => {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.error) throw new Unevaluable(`could not run git: ${r.error.message}`);
    if (r.status !== 0 && !allowFail) throw new Unevaluable(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return { out: r.stdout, status: r.status, err: r.stderr };
  };
}

function history(git, base, count) {
  // %x1f separates fields; a subject may contain tabs but never a unit separator.
  const { out } = git(['log', '--first-parent', '-n', String(count), '--format=%H%x1f%P%x1f%s', base]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, parents, ...subject] = line.split('\x1f');
    return { sha, firstParent: parents.split(' ')[0] || null, subject: subject.join('\x1f') };
  });
}

function shallowBoundary(git) {
  if (git(['rev-parse', '--is-shallow-repository']).out.trim() !== 'true') return null;
  const file = git(['rev-parse', '--git-path', 'shallow']).out.trim();
  return new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
}

function commitChanges(git, c) {
  const args = c.firstParent ? [c.firstParent, c.sha] : ['--root', c.sha];
  return parseRawDiffZ(git(['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', ...args]).out);
}

/** Load `count` commits of the base with their first-parent diffs, refusing a truncated history. */
function loadCommits(git, base, count) {
  const list = history(git, base, count);
  const boundary = shallowBoundary(git);
  if (boundary) {
    const cut = list.find((c) => boundary.has(c.sha));
    if (cut || list.length < count) {
      throw new Unevaluable(
        `this checkout is shallow and its history ends ${cut ? `at ${cut.sha.slice(0, 10)}` : `after ${list.length} commit(s)`}, ` +
          `short of the ${count} commits the window needs. Deepen it (actions/checkout fetch-depth: 0, or git fetch --unshallow); ` +
          'a verdict from truncated history would pass by examining nothing.'
      );
    }
  }
  return list.map((c) => ({ ...c, changes: commitChanges(git, c) }));
}

/** The tree the merge will produce, diffed against the base tip. */
function mergedChange(git, base, head) {
  const mb = git(['merge-base', base, head], { allowFail: true });
  if (mb.status !== 0 || !mb.out.trim()) {
    throw new Unevaluable(
      `no merge base between ${base} and ${head}` +
        (shallowBoundary(git) ? ' (shallow checkout: deepen it)' : ' (unrelated histories, or a ref that was not fetched)')
    );
  }
  const mt = git(['merge-tree', '--write-tree', '--no-messages', base, head], { allowFail: true });
  if (mt.status === 1) throw new Unevaluable(`${head} does not merge cleanly into ${base}; rebase and resolve the conflict, then re-run`);
  if (mt.status !== 0) {
    throw new Unevaluable(`git merge-tree --write-tree failed (git >= 2.38 is required): ${mt.err.trim() || `exit ${mt.status}`}`);
  }
  const tree = mt.out.split('\n')[0].trim();
  const net = parseRawDiffZ(git(['diff-tree', '-r', '-z', '--no-renames', `${base}^{tree}`, tree]).out);
  const moved = Number(git(['rev-list', '--first-parent', '--count', `${mb.out.trim()}..${base}`]).out.trim());
  return { net, mergeBase: mb.out.trim(), moved };
}

export function evaluate({ git, base, head, window, minFiles, declarations }) {
  const { net, mergeBase, moved } = mergedChange(git, base, head);
  // Attribute against the larger of "the last N" and "everything since the merge base";
  // look back another N beyond that so the un-revert rule can see the commit it repairs.
  const attributable = Math.max(window, moved);
  const commits = loadCommits(git, base, attributable + window);
  const findings = findSilentReverts({ net, commits, attributable, minFiles });
  const { undeclared, declared, reason } = applyDeclarations(findings, declarations);
  return { netFiles: net.size, examined: Math.min(attributable, commits.length), mergeBase, moved, findings, undeclared, declared, reason };
}

/** Replay one merged commit as a PR: its own first-parent diff is the merge result. */
function evaluateMerged(git, entry, history_, index, window, minFiles) {
  const net = new Map(history_[index].changes);
  const commits = history_.slice(index + 1);
  const message = git(['log', '-1', '--format=%s%x1f%b', entry.sha]).out.split('\x1f');
  const declarations = parseDeclarations({ title: message[0].trim(), body: message[1] ?? '' });
  const findings = findSilentReverts({ net, commits, attributable: Math.min(window, commits.length), minFiles });
  return { entry, ...applyDeclarations(findings, declarations), findings, netFiles: net.size };
}

function scan(git, base, n, window, minFiles) {
  const loaded = loadCommits(git, base, n + 2 * window);
  const rows = [];
  for (let i = 0; i < n && i + 1 < loaded.length; i += 1) {
    if (loaded[i].firstParent === null) continue;
    rows.push(evaluateMerged(git, loaded[i], loaded, i, window, minFiles));
  }
  return rows;
}

function parseArgs(argv) {
  const o = { base: 'origin/main', head: 'HEAD', window: DEFAULT_WINDOW, minFiles: DEFAULT_MIN_FILES, labels: [], scan: null, json: false, root: null, title: null, body: null };
  const need = (i) => { if (i + 1 >= argv.length) throw new Unevaluable(`${argv[i]} needs a value`); return argv[i + 1]; };
  const num = (flag, v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Unevaluable(`${flag} must be a positive integer, got ${v}`); return n; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--label') o.labels.push(need(i++));
    else if (a === '--base') o.base = need(i++);
    else if (a === '--head') o.head = need(i++);
    else if (a === '--title') o.title = need(i++);
    else if (a === '--body') o.body = need(i++);
    else if (a === '--root') o.root = resolve(need(i++));
    else if (a === '--window') o.window = num(a, need(i++));
    else if (a === '--min-files') o.minFiles = num(a, need(i++));
    else if (a === '--scan') o.scan = num(a, need(i++));
    else throw new Unevaluable(`unknown argument ${a}`);
  }
  return o;
}

function declarationInputs(o, git) {
  let labels = o.labels;
  if (!labels.length && process.env.PR_LABELS) {
    try { labels = JSON.parse(process.env.PR_LABELS); } catch { throw new Unevaluable('PR_LABELS is not a JSON array'); }
  }
  let title = o.title ?? process.env.PR_TITLE ?? null;
  let body = o.body ?? process.env.PR_BODY ?? '';
  let source = 'the PR';
  if (title === null) {
    const m = git(['log', '-1', '--format=%s%x1f%b', o.head]).out.split('\x1f');
    title = m[0].trim(); body = m[1] ?? ''; source = 'the head commit message';
  }
  return { title, body, labels, source };
}

function summarize(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function main(argv) {
  const o = parseArgs(argv);
  const root = o.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const git = makeGit(root);

  if (o.scan) {
    const rows = scan(git, o.base, o.scan, o.window, o.minFiles);
    const flagged = rows.filter((r) => r.undeclared.length);
    const declared = rows.filter((r) => r.declared.length);
    if (o.json) console.log(JSON.stringify({ scanned: rows.length, flagged: flagged.map((r) => ({ sha: r.entry.sha, subject: r.entry.subject, undoes: r.undeclared.map((f) => f.sha) })) }));
    else {
      console.log(`check-silent-revert: replayed ${rows.length} commit(s) ending at ${o.base}, window ${o.window}, min ${o.minFiles} files.`);
      for (const r of declared) console.log(`  declared: ${r.entry.sha.slice(0, 10)} ${r.entry.subject}`);
      for (const r of flagged) console.log(`\nFLAGGED ${r.entry.sha.slice(0, 10)} ${r.entry.subject}\n${r.undeclared.map((f) => formatFindingBrief(f)).join('\n')}`);
      console.log(`\n${flagged.length} of ${rows.length} flagged.`);
    }
    return flagged.length ? 1 : 0;
  }

  const decl = declarationInputs(o, git);
  const declarations = parseDeclarations(decl);
  const r = evaluate({ git, base: o.base, head: o.head, window: o.window, minFiles: o.minFiles, declarations });
  if (o.json) { console.log(JSON.stringify({ ...r, findings: undefined, declared: r.declared.map((f) => f.sha), undeclared: r.undeclared })); }
  const scope = `${r.netFiles} file(s) changed by the merge against ${o.base}; ${r.examined} base commit(s) examined (merge base ${r.mergeBase.slice(0, 10)}, base moved ${r.moved} since).`;
  if (r.undeclared.length) {
    const text = formatFailure(r.undeclared);
    console.error(`check-silent-revert: ${scope}\n\n${text}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.error(`::error title=Silent revert::${r.undeclared.map((f) => `${f.restored.length} files of ${f.pr === null ? f.sha.slice(0, 10) : `#${f.pr}`} restored`).join('; ')}. See the job log.`);
    summarize(['### Silent revert', '```', text, '```']);
    return 1;
  }
  const note = r.declared.length ? ` Declared by ${r.reason} (${decl.source}): ${r.declared.map((f) => (f.pr === null ? f.sha.slice(0, 10) : `#${f.pr}`)).join(', ')}.` : '';
  if (!o.json) console.log(`check-silent-revert: OK. ${scope}${note}`);
  return 0;
}

function formatFindingBrief(f) {
  return `    undoes ${f.pr === null ? '' : `#${f.pr} `}${f.sha.slice(0, 10)} ${f.subject} (${f.restored.length}/${f.touched} files)`;
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof Unevaluable)) throw err;
    // Exit 2, never 1 and never 0: "could not look" is neither a verdict nor a pass.
    console.error(`check-silent-revert: COULD NOT EVALUATE (failing closed): ${err.message}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.error(`::error title=Silent-revert guard::could not evaluate: ${err.message}`);
    process.exitCode = 2;
  }
}
