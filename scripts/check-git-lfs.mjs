#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * check-git-lfs.mjs - a READ-ONLY detector for leftover Git LFS hooks.
 *
 * WHAT IT INSPECTS, AND IT IS PROBABLY NOT WHAT YOU EXPECT
 *
 *   It inspects THE REPOSITORY THIS SCRIPT FILE LIVES IN, resolved from
 *   `import.meta.url`, NOT the current working directory. Running it from
 *   somewhere else, a sandbox included, does not move the target: it still
 *   reports on this clone.
 *
 *   The hooks directory it reads is whatever `git rev-parse --git-path hooks`
 *   resolves to, and that honours `core.hooksPath`. A fresh clone leaves that
 *   unset, but if someone has set it, it can be an ABSOLUTE path to another
 *   checkout's `.git/hooks`, shared by every linked worktree of that clone. In
 *   that case the directory named in the output is NOT the `.git/hooks` under
 *   the checkout you are standing in. Read the path it prints before acting on
 *   it; the output names it whenever `core.hooksPath` is set.
 *
 * WHY DETECTION ONLY
 *
 *   This script used to have a `--fix` mode that deleted the hook files and
 *   cleared the repo-local `filter.lfs.*` config. Four rounds of hardening
 *   kept finding new ways for an automated `.git` mutation to go wrong:
 *   partial config/hook states, a config value containing a newline that unset
 *   unrelated keys, a race with a concurrent hook installer, and finally the
 *   target-resolution surprise above, where a run started from a throwaway
 *   directory reached through `core.hooksPath` and deleted the real clone's
 *   hooks. Detection carries none of that risk and gets nearly all of the
 *   value, because the remedy is a single command the developer runs.
 *
 * THIS SCRIPT NEVER WRITES
 *
 *   From `node:fs` it imports `readFileSync` and `statSync` and nothing else:
 *   no `unlink`, no `writeFile`, no `rmSync`. It spawns `git` from exactly one
 *   place, and that is the complete list of subcommands it can run, all reads:
 *
 *       git rev-parse --is-inside-work-tree
 *       git rev-parse --git-path hooks
 *       git rev-parse --git-path info/attributes
 *       git rev-parse --show-toplevel
 *       git config --get core.hooksPath
 *       git config --get core.attributesFile
 *       git ls-files -z --cached --others --exclude-standard [-- <pathspecs>]
 *       git check-attr filter --stdin -z
 *
 *   No `git config --unset`, no `--remove-section`, no `--replace-all`, no
 *   `git lfs` at all. `git ls-files` above is git's own index/worktree
 *   listing, not `git lfs ls-files`: the latter writes
 *   `lfs.repositoryformatversion` into `.git/config` (confirmed with git-lfs
 *   3.7.1 in a throwaway clone), which is why "does this repo use Git LFS?"
 *   is answered from git attributes alone. `git check-attr` only reports the
 *   attributes that apply to a path; running it in a throwaway repo left
 *   `git config --local -l` and every file under `.git` byte-identical.
 *
 * BACKGROUND
 *
 *   This repo retired Git LFS, but its history still contains LFS pointer
 *   blobs; a plain clone from origin holds 80 of them. Nothing at HEAD is a
 *   pointer: no `.gitattributes` has a `filter=lfs` rule, and fixtures are
 *   fetched on demand with `pnpm fixtures`.
 *
 *   Hooks are not version-controlled, so retiring LFS on a branch cannot
 *   remove a hook that already sits in someone's clone. The `pre-push` hook
 *   runs `git lfs pre-push <remote> <url>`, which asks git what is about to be
 *   pushed with `git rev-list --objects <sha> --not --remotes=<remote>`. With
 *   no remote-tracking refs for that remote, the normal state right after
 *   `git remote add fork ...`, the `--not` side excludes nothing, the range
 *   widens to the whole history, and every historical LFS pointer is queued
 *   for upload. The push then fails while git-lfs uploads them.
 *
 *   Who is affected: clones predating the LFS retirement, and clones where
 *   someone ran `git lfs install`. A clone made today installs no LFS hooks.
 *
 * THE REMEDIES IT PRINTS, AND THE HAZARD IN THE BIGGEST ONE
 *
 *   `git lfs uninstall --local` is clone-scoped in its CONFIG effect only.
 *   Per `git lfs uninstall --help`, `--local` removes the lfs smudge and
 *   clean filters from the local repository's git config "instead of the
 *   global git config (~/.gitconfig)"; the same help text also says it will
 *   "Uninstall the Git LFS pre-push hook if run from inside a Git
 *   repository", and that hook removal is NOT scoped by `--local`. It deletes
 *   git-lfs's hooks from whatever `core.hooksPath` resolves to, which is the
 *   same lookup this script reports on.
 *
 *   Measured with git-lfs 3.7.1 and git 2.50.1 in throwaway repos: with
 *   `core.hooksPath` pointing at ANOTHER repository's `.git/hooks` (set
 *   locally in one run, globally in another), `git lfs uninstall --local` run
 *   from a repo that had no LFS config of its own deleted that other
 *   repository's `pre-push`, `post-checkout`, `post-commit` and `post-merge`.
 *   An unrelated `pre-commit` hook in the same directory survived, so it
 *   removes git-lfs's own hooks rather than everything, but the repository
 *   that owned them loses its `pre-push`, and per `git lfs pre-push --help`
 *   that hook is what pushes a commit's LFS objects to the LFS API. Without
 *   it, that repository's pushes stop uploading its LFS objects.
 *
 *   Linked worktrees hit the same sharing without anyone setting
 *   `core.hooksPath`: a linked worktree resolves `--git-path hooks` to the
 *   main clone's `.git/hooks` (verified with `git rev-parse`), so every
 *   worktree of a clone shares one hooks directory.
 *
 *   That is why the report warns before it prints the command, and offers
 *   `git push --no-verify` (changes nothing) and deleting the single
 *   `pre-push` file (narrowest change) first.
 *
 * WHEN IT STAYS SILENT, AND WHICH WAY IT ERRS
 *
 *   Silence needs a `filter=lfs` rule that APPLIES to a path that exists
 *   here, not merely a rule somewhere. `git check-attr filter --stdin -z` is
 *   asked, over the paths `git ls-files --cached --others --exclude-standard`
 *   lists, capped at CHECK_ATTR_PATH_LIMIT. On this repo that listing is
 *   ~4.2k paths and the pipe takes ~20ms, so the cap only bites on a checkout
 *   several times this size; and the scan runs at most once, only after a
 *   rule was already found, so the usual run never pays for it.
 *
 *   If the answer cannot be established, because git refused or because the
 *   listing was longer than the cap, it REPORTS the hooks and says which of
 *   the two it was. Reporting a repo that is fine costs a message the reader
 *   can ignore; staying silent costs the failed push this exists to prevent.
 *
 * EXIT CODES
 *
 *   1 when leftover git-lfs hooks are present in this clone, 0 otherwise: no
 *   such hooks, not a git work tree, this checkout genuinely uses
 *   `filter=lfs` on a path that exists, or the hooks directory could not be
 *   resolved at all.
 *
 *   This is a local-developer tool. It is NOT wired into CI or into any
 *   install hook, and it must stay that way.
 */

import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// The hooks `git lfs install` writes. Only pre-push blocks a push; the others
// just spawn git-lfs on every checkout/commit/merge for no reason.
const LFS_HOOKS = ['pre-push', 'post-checkout', 'post-commit', 'post-merge'];

/** Read-only git call, always against this script's own repo. */
function git(args, opts = {}) {
  // 64 MiB by default, not node's 1 MiB: `ls-files` over a big checkout can
  // exceed that, and spawnSync truncates silently rather than erroring, which
  // would make a repo look like it has fewer paths than it does. Callers can
  // still override.
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  // `raw` is for NUL-separated output, where trimming could eat a leading
  // space in the first path.
  return { ok: r.status === 0, status: r.status, stdout: (r.stdout || '').trim(), raw: r.stdout || '' };
}

// --- Is this even a git work tree? ----------------------------------------
// Check the printed value, not just the exit status: a bare repo answers
// "false" with exit 0.
const insideWorkTree = git(['rev-parse', '--is-inside-work-tree']);
if (!insideWorkTree.ok || insideWorkTree.stdout !== 'true') {
  console.log('✅ Not a git work tree, nothing to check.');
  process.exit(0);
}

// --- Where does this clone keep its hooks? --------------------------------
const hooksDirRaw = git(['rev-parse', '--git-path', 'hooks']);
if (!hooksDirRaw.ok || !hooksDirRaw.stdout) {
  console.error(`⚠️  Cannot tell where this clone keeps its hooks
   (\`git rev-parse --git-path hooks\` exited ${hooksDirRaw.status}), so this
   check cannot run. Nothing was inspected and nothing was changed.`);
  process.exit(0);
}
const hooksDir = resolve(ROOT, hooksDirRaw.stdout);
const configuredHooksPath = git(['config', '--get', 'core.hooksPath']).stdout;

// --- Which of those hooks are git-lfs's? ----------------------------------
// git-lfs hooks are three lines: `#!/bin/sh`, an optional "is git-lfs on
// PATH?" guard, and `git lfs <hookname> "$@"` last. Requiring that dispatch
// line is enough to tell one from an unrelated hook such as husky's pre-push.
// This classifier does not need to be airtight: since nothing is ever
// deleted, a misclassification costs a wrong message, not a lost file.
const dispatchRe = (name) => new RegExp(String.raw`^git[- ]lfs\s+${name}\b`, 'm');

const found = [];
const unreadable = [];
for (const name of LFS_HOOKS) {
  const path = join(hooksDir, name);
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') unreadable.push(`${path} (${err.message})`);
    continue;
  }
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '').trim());
  if (!lines.some((l) => dispatchRe(name).test(l))) continue; // somebody else's hook
  found.push({ name, path });
}

if (found.length === 0) {
  console.log(`✅ No leftover Git LFS hooks in ${hooksDir}.`);
  if (unreadable.length > 0) {
    console.log(`   (Could not read: ${unreadable.join(', ')})`);
  }
  process.exit(0);
}

// --- Does this checkout genuinely use LFS? --------------------------------
// A file is an LFS file because a `filter=lfs` attribute APPLIES TO IT, so a
// rule on its own settles nothing: a leftover `*.psd filter=lfs` in a repo
// with no `.psd` files would otherwise silence this check for exactly the
// person who needs it. So this is two questions, and both must answer yes:
//
//   1. is there a `filter=lfs` rule at all, and in which file?  (cheap, and
//      it is what lets the output name the file)
//   2. does that rule apply to a path that exists in this checkout?  (asked
//      of `git check-attr`, which is git's own answer to it)
//
// The attributes that count are the ones on disk right now: `git lfs track`
// writes `.gitattributes` without committing it, so a repo half-way through
// ADOPTING LFS must not read as one that retired it. `git check-attr` without
// `--cached` reads the working tree, and also honours `.git/info/attributes`
// and `core.attributesFile` (both verified).
const ATTR_LFS_RE = /(^|\s)filter=lfs(\s|$)/;

function declaresLfs(text) {
  return text.split('\n').some((raw) => {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) return false;
    return ATTR_LFS_RE.test(line);
  });
}

function readIfFile(path) {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function globalAttributesPath() {
  const cfg = git(['config', '--get', 'core.attributesFile']);
  if (cfg.ok && cfg.stdout) {
    return cfg.stdout.startsWith('~/') ? join(homedir(), cfg.stdout.slice(2)) : resolve(ROOT, cfg.stdout);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'git', 'attributes') : join(homedir(), '.config', 'git', 'attributes');
}

function attributeFilesDeclaringLfs() {
  const candidates = [];
  // Search from the work tree root, so a `.gitattributes` above this directory
  // is seen too. Tracked (`--cached`, read from disk) and untracked
  // (`--others`) alike; nothing here reads blob contents.
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.ok && top.stdout) {
    const ls = git(
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/.gitattributes', '.gitattributes'],
      { cwd: top.stdout },
    );
    if (ls.ok) candidates.push(...ls.raw.split('\0').filter(Boolean).map((rel) => resolve(top.stdout, rel)));
  }
  // `.git/info/attributes` is not version-controlled but carries the same
  // weight, and so does the user's global attributes file.
  const info = git(['rev-parse', '--git-path', 'info/attributes']);
  if (info.ok && info.stdout) candidates.push(resolve(ROOT, info.stdout));
  candidates.push(globalAttributesPath());

  const declaring = [];
  for (const path of [...new Set(candidates)]) {
    const text = readIfFile(path);
    if (text !== null && declaresLfs(text)) declaring.push(path);
  }
  return declaring;
}

// How many paths this is willing to hand to `git check-attr`. On this repo the
// whole listing is ~4.2k paths and `ls-files | check-attr` takes ~20ms, so the
// bound only bites on a checkout more than about five times this size. It is a
// bound on work, not on correctness for repos of this size, and the scan runs
// at most once, only after a `filter=lfs` rule was already found.
const CHECK_ATTR_PATH_LIMIT = 20000;

/**
 * Ask git whether `filter=lfs` actually applies to a path that exists here.
 * Returns 'applies' with the first such path, 'unused' when the complete
 * listing was checked and nothing matched, or 'unknown' when git would not
 * answer or the listing was longer than the bound.
 */
function lfsFilterAppliesToAPath() {
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout) return { verdict: 'unknown', why: '`git rev-parse --show-toplevel` failed' };

  const ls = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: top.stdout });
  if (!ls.ok) return { verdict: 'unknown', why: '`git ls-files` failed' };
  const paths = ls.raw.split('\0').filter(Boolean);
  if (paths.length === 0) return { verdict: 'unused', checked: 0 };
  const checked = paths.slice(0, CHECK_ATTR_PATH_LIMIT);

  // `--stdin -z` so paths with spaces, quotes or newlines survive the trip.
  const attr = git(['check-attr', 'filter', '--stdin', '-z'], {
    cwd: top.stdout,
    input: `${checked.join('\0')}\0`,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!attr.ok) return { verdict: 'unknown', why: `\`git check-attr\` exited ${attr.status}` };

  // Output is flat NUL-separated triples: <path> <attr> <value>.
  const f = attr.raw.split('\0');
  for (let i = 0; i + 2 < f.length; i += 3) {
    if (f[i + 1] === 'filter' && f[i + 2] === 'lfs') return { verdict: 'applies', path: f[i] };
  }
  if (checked.length < paths.length) {
    return { verdict: 'unknown', why: `checked the first ${checked.length} of ${paths.length} paths`, checked: checked.length };
  }
  return { verdict: 'unused', checked: checked.length };
}

const declaring = attributeFilesDeclaringLfs();
let applies = null;
if (declaring.length > 0) {
  applies = lfsFilterAppliesToAPath();
  if (applies.verdict === 'applies') {
    console.log(`✅ This checkout tracks files with Git LFS, so its LFS hooks belong there.
   filter=lfs is declared in:
${declaring.map((p) => `      ${p}`).join('\n')}
   and \`git check-attr\` says it applies to ${applies.path}`);
    process.exit(0);
  }
}

// --- Report. ---------------------------------------------------------------
// The `filter=lfs` rules that exist but match nothing. Saying which file they
// are in matters: a stale rule used to silence this check entirely, and the
// reader may want to delete it.
const staleRules =
  declaring.length === 0
    ? ''
    : applies.verdict === 'unused'
      ? `
A \`filter=lfs\` rule exists here, but it is stale: \`git check-attr filter\`
finds no path among the ${applies.checked} in this checkout that it applies to,
so nothing here is an LFS file. The rule is in:
${declaring.map((p) => `   ${p}`).join('\n')}
`
      : `
A \`filter=lfs\` rule exists here, in:
${declaring.map((p) => `   ${p}`).join('\n')}
but whether it applies to any real path could not be established
(${applies.why}). This errs toward reporting rather than toward
silence, so if this checkout really does use Git LFS, ignore the rest.
`;

const pushHook = found.find((h) => h.name === 'pre-push');

console.error(`❌ This clone still has Git LFS hooks, but this repo has no LFS content.

Checked the repo this script lives in (${ROOT}), NOT the current directory.

Leftover hooks in ${hooksDir}:
${found.map((h) => `   ${h.path}`).join('\n')}
${staleRules}
\`git lfs pre-push\` asks git for the objects being pushed with
\`--not --remotes=<remote>\`. Push to a remote this clone has no
remote-tracking refs for, a fork you just added, and that excludes nothing,
so the range becomes the whole history, which still holds LFS pointer blobs.
git-lfs queues those for upload and the push fails uploading them, even though
your own commits contain no LFS files.

READ THIS BEFORE RUNNING ANY REMEDY
${
  configuredHooksPath
    ? `
core.hooksPath is set to
   ${configuredHooksPath}
so that, rather than the .git/hooks of whatever checkout you are standing in,
is the directory listed above. It may be this clone's own, or another
repository's. Every linked worktree of the clone that owns it shares it too.
Check which checkouts it serves before you touch it.`
    : `
The hooks directory above is shared by every linked worktree of this clone,
and a core.hooksPath setting elsewhere can point other repositories at it too.`
}

\`git lfs uninstall\` deletes git-lfs's hooks from whatever core.hooksPath
resolves to, and \`--local\` does NOT scope that: it scopes the config edit
only. A repository that loses its \`pre-push\` this way stops uploading its LFS
objects on push, and it will not tell you.

Remedies, least invasive first.

1. Change nothing on disk, get this push out. Note this skips EVERY
   pre-push hook, not only the Git LFS one, so run whatever else your
   clone checks at push time yourself:
      git push --no-verify <remote> <branch>

2. Narrowest fix, this hook only, no config touched. Read the file first:
   if it runs anything besides git-lfs's guard and dispatch, delete only
   the git-lfs lines instead of the whole file:
      rm ${pushHook ? pushHook.path : join(hooksDir, 'pre-push')}

3. Whole-clone fix, only once you are sure no other checkout shares the
   directory above:
      git lfs uninstall --local

   Per \`git lfs uninstall --help\`, \`--local\` removes the lfs filters from
   this repository's git config instead of the global ~/.gitconfig, so your
   Git LFS config in other repos is left alone. Its hook removal is not
   limited that way.

Then re-run \`pnpm check:git-lfs\`. If a hook is still listed, read it and
delete the file yourself.
`);
if (unreadable.length > 0) {
  console.error(`Also could not read: ${unreadable.join(', ')}\n`);
}
process.exit(1);
