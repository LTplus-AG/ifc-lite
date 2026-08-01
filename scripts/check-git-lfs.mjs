#!/usr/bin/env node
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
 *       git ls-files -z --cached --others --exclude-standard -- <pathspecs>
 *
 *   No `git config --unset`, no `--remove-section`, no `--replace-all`, no
 *   `git lfs` at all. `git ls-files` above is git's own index/worktree
 *   listing, not `git lfs ls-files`: the latter writes
 *   `lfs.repositoryformatversion` into `.git/config` (confirmed with git-lfs
 *   3.7.1 in a throwaway clone), which is why "does this repo use Git LFS?"
 *   is answered from git attributes alone.
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
 * THE REMEDY IT PRINTS
 *
 *   `git lfs uninstall --local`. Per `git lfs uninstall --help`, `--local`
 *   removes the lfs smudge and clean filters from the local repository's git
 *   config "instead of the global git config (~/.gitconfig)", so the
 *   developer's global Git LFS setup keeps working everywhere else.
 *
 * EXIT CODES
 *
 *   1 when leftover git-lfs hooks are present in this clone, 0 otherwise: no
 *   such hooks, not a git work tree, this checkout genuinely declares
 *   `filter=lfs`, or the hooks directory could not be resolved at all.
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
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8', ...opts });
  return { ok: r.status === 0, status: r.status, stdout: (r.stdout || '').trim() };
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
// A file is an LFS file because a `filter=lfs` attribute applies to it, so the
// attributes are the authority, and the ones that count are the ones on disk
// right now: `git lfs track` writes `.gitattributes` without committing it, so
// a repo half-way through ADOPTING LFS must not read as one that retired it.
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
    if (ls.ok) candidates.push(...ls.stdout.split('\0').filter(Boolean).map((rel) => resolve(top.stdout, rel)));
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

const declaring = attributeFilesDeclaringLfs();
if (declaring.length > 0) {
  console.log(`✅ This checkout tracks files with Git LFS, so its LFS hooks belong there.
   filter=lfs is declared in:
${declaring.map((p) => `      ${p}`).join('\n')}`);
  process.exit(0);
}

// --- Report. ---------------------------------------------------------------
console.error(`❌ This clone still has Git LFS hooks, but this repo has no LFS content.

Checked the repo this script lives in (${ROOT}), NOT the current directory.

Leftover hooks in ${hooksDir}:
${found.map((h) => `   ${h.path}`).join('\n')}
${
  configuredHooksPath
    ? `
core.hooksPath is set to ${configuredHooksPath}, so that is the directory
above, and every worktree of that clone shares it. It may well not be the
.git/hooks of the checkout you are in.
`
    : ''
}
\`git lfs pre-push\` asks git for the objects being pushed with
\`--not --remotes=<remote>\`. Push to a remote this clone has no
remote-tracking refs for, a fork you just added, and that excludes nothing,
so the range becomes the whole history, which still holds LFS pointer blobs.
git-lfs queues those for upload and the push fails uploading them, even though
your own commits contain no LFS files.

Remedy, one command, run it yourself:
   git lfs uninstall --local

\`--local\` is clone-scoped: per \`git lfs uninstall --help\` it removes the lfs
filters from this repository's git config instead of the global
~/.gitconfig, so your Git LFS setup in other repos is left alone.

Then re-run \`pnpm check:git-lfs\`. If a hook is still listed, read it and
delete the file yourself.

To get one push out without changing anything:
   git push --no-verify <remote> <branch>
`);
if (unreadable.length > 0) {
  console.error(`Also could not read: ${unreadable.join(', ')}\n`);
}
process.exit(1);
