/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The top-level workflow files whose edit can change a Test cache key, so a
 * push touching one must still run in full on main (ci-push-replay.mjs).
 *
 * A workflow file reaches a cache key in one of two ways: it is executed by the
 * run (test.yml, or a reusable workflow test.yml calls with `uses: ./...`), so
 * its own text sets keys; or a `hashFiles(...)` or `cache-dependency-path` in an
 * executed file hashes it. Executed files are those workflows plus every file
 * under `.github/actions/` (which ci-push-replay blocks on its own). A step that
 * merely READS another workflow is test behaviour, already covered by the
 * exact-tree evidence.
 *
 * THE SCAN IS AN ALLOW-LIST. Every `uses:` value, `cache-dependency-path:`
 * value and hashFiles argument must be one of a few plain forms; anything else
 * (a YAML tag, alias, escape, flow list, block scalar, expression, `~`, `..`)
 * makes the answer unknown, and the caller blocks every workflow file. Each
 * allowed pattern is then judged for whether it can reach
 * `.github/workflows/<x>.yml`, directories included, since hashFiles hashes
 * every file below a matched one. Patterns are judged relative to the workspace
 * root, where Test checks the repository out (no checkout `path:`). Not
 * detected: a key computed in a `run:` step or a script from a workflow file's
 * bytes (a `key:` from a step output), or by a remote action's other inputs.
 */

import { posix } from 'node:path';

export const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/**
 * Every occurrence of `key:` on a line that is not a comment, several per line in a
 * flow mapping, as [what precedes it (a `{` means a flow mapping), the rest of the line].
 */
function keyEntries(text, key) {
  // Not after `-`: `my-uses:` is another key, and a list item's `- uses:` has a space.
  const re = new RegExp(`(^|[\\s{[,])['"]?${key}['"]?[ \\t]*:`, 'g');
  const out = [];
  for (const line of text.split('\n')) {
    if (/^[ \t]*#/.test(line)) continue;
    for (const m of line.matchAll(re)) out.push([line.slice(0, m.index + m[1].length), line.slice(m.index + m[0].length)]);
  }
  return out;
}
// In YAML (not in an action's scripts): a hex or unicode escape can spell a key or a call
// the scan looks for (`"u\x73es":`, `hashFiles\x28`), and `? ` starts a complex key.
const YAML_HIDDEN = /\\[xuU][0-9A-Fa-f]|(?:^|[\s{[,])\?[ \t]/m;
const IS_YAML = /\.ya?ml$/;
// Expression function names are case-insensitive, and `hashFiles (` is a call (a `\t`
// escape in a double-quoted scalar is whitespace too).
const HASHFILES = /hashFiles(?:\s|\\t)*\(/gi;
// An escaped line break in a double-quoted YAML scalar joins the lines (`hash\` newline
// `Files(`). Joining every `\`-newline also matches what a shell does in run: blocks.
const joinEscapedBreaks = (text) => text.replace(/\\\r?\n[ \t]*/g, '');
const QUOTED_ARG = /^\s*(?:'([^']*)'|"([^"]*)")\s*([,)])/;

// The allowed forms. A path is plain characters only: no escapes, `~`, `!`, braces or brackets.
const PLAIN_PATH = /^[\w./*-]+$/;
const LOCAL_WORKFLOW = /^\.\/(\.github\/workflows\/[\w.-]+\.ya?ml)$/;
const LOCAL_ACTION = /^\.\/\.github\/actions\/[\w.-]+(?:\/[\w.-]+)*$/;
const REMOTE_ACTION = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[\w./-]+$/;
const DOCKER = /^docker:\/\/\S+$/;

/**
 * The scalar a `key: <rest>` line gives: comment dropped, in a flow mapping the entry's
 * tail (`, ...` / ` }`) too (in block context a comma is part of the scalar), one
 * quote pair removed. Null when unquoted text starts with a YAML indicator (alias `*`,
 * anchor `&`, tag `!`, block `|` `>`, flow `[` `{`, reserved `%` `@` backtick): then
 * the line does not show the value.
 */
function scalar(before, rest) {
  let v = rest.replace(/[ \t]+#.*$/, '').trim();
  if (before.includes('{')) v = v.replace(/[ \t]*[,}].*$/, '');
  const quoted = /^(['"])(.*)\1$/.exec(v);
  if (quoted) return quoted[2];
  return /^[*&!|>[{%@`]/.test(v) ? null : v;
}

/** A hashFiles call's quoted arguments, or null when one is not a quoted literal. */
function hashFilesArgs(text, from) {
  const args = [];
  let rest = text.slice(from);
  for (;;) {
    const m = QUOTED_ARG.exec(rest);
    if (!m) return null;
    args.push(m[1] ?? m[2]);
    rest = rest.slice(m[0].length);
    if (m[3] === ')') return args;
  }
}

const WORKFLOW_SEGMENTS = ['.github', 'workflows'];
const isWild = (seg) => seg.includes('*');

/** Whether one glob segment can match target segment `ti` (0 `.github`, 1 `workflows`, 2 any YAML name). */
function segmentMatches(seg, ti) {
  if (ti === 2) return isWild(seg) || /\.ya?ml$/.test(seg);
  if (!isWild(seg)) return seg === WORKFLOW_SEGMENTS[ti];
  return new RegExp(`^${seg.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`).test(WORKFLOW_SEGMENTS[ti]);
}

/**
 * Whether `segs` can match `.github`, `.github/workflows` or a YAML file in it.
 * hashFiles hashes every file below a matched directory, so an ancestor counts.
 */
function reachesWorkflows(segs, pi = 0, ti = 0) {
  if (pi === segs.length) return ti >= 1;
  if (segs[pi] === '**') return reachesWorkflows(segs, pi + 1, ti) || (ti < 3 && reachesWorkflows(segs, pi, ti + 1));
  if (ti >= 3) return false;
  return segmentMatches(segs[pi], ti) && reachesWorkflows(segs, pi + 1, ti + 1);
}

/** For one plain pattern: the workflow file it names, 'none', or 'unknown' (it may reach one it does not name). */
function judgePattern(pattern) {
  const segs = pattern.replace(/^\.\//, '').split('/');
  // The workspace root, an absolute path, an empty or climbing segment, or a trailing slash.
  if (pattern === '.' || pattern === './' || pattern.startsWith('/') || segs.some((s) => s === '' || s === '.' || s === '..')) return 'unknown';
  if (!reachesWorkflows(segs)) return 'none';
  const p = segs.join('/');
  return WORKFLOW_FILE.test(p) && !segs.some(isWild) ? p : 'unknown';
}

/**
 * @param {{
 *   root: string,
 *   actionFiles: string[] | null,
 *   symlinks: Array<{ path: string, target: string }> | null,
 *   readText: (path: string) => string | null,
 * }} input `root` is `.github/workflows/test.yml`; `actionFiles` every file under
 *   `.github/actions/` at the commit (null when unlisted); `symlinks` every
 *   symlink in the tree with its target (null when unlisted); `readText` a file's
 *   text at the commit (null when absent).
 * @returns {{ files: string[] } | { unknown: string }} the sorted workflow files
 *   that key Test's caches, `root` included, or why that cannot be told.
 */
export function workflowsKeyingCaches({ root, actionFiles, symlinks, readText }) {
  if (!Array.isArray(actionFiles)) return { unknown: 'the .github/actions/ files could not be listed' };
  if (!Array.isArray(symlinks)) return { unknown: 'the symlinks could not be listed' };
  // hashFiles follows symlinks, and a link inside .github/ can hide what an action runs.
  for (const { path, target } of symlinks) {
    const to = posix.normalize(posix.join(posix.dirname(path), target)).replace(/(.)\/$/, '$1');
    if (path === '.github' || path.startsWith('.github/') || target.startsWith('/') || to === '.' || to === '..' || to.startsWith('../') || to === '.github' || to.startsWith('.github/')) {
      return { unknown: `symlink ${path} -> ${target} may reach .github/` };
    }
  }
  const files = new Set([root]);
  const executed = [root, ...actionFiles];
  for (let i = 0; i < executed.length; i += 1) {
    const path = executed[i];
    const text = readText(path);
    if (typeof text !== 'string') return { unknown: `${path} could not be read` };
    if (IS_YAML.test(path) && YAML_HIDDEN.test(text)) return { unknown: `${path} has a YAML escape or complex key the scan cannot read through` };
    for (const [before, rest] of keyEntries(text, 'uses')) {
      const v = scalar(before, rest);
      if (v === null) return { unknown: `${path} has a uses: value the line does not show` };
      if (v.split('/').includes('..')) return { unknown: `${path} has uses: ${v}, which climbs` };
      const local = LOCAL_WORKFLOW.exec(v);
      if (local) {
        files.add(local[1]);
        if (!executed.includes(local[1])) executed.push(local[1]);
      } else if (!LOCAL_ACTION.test(v) && !(REMOTE_ACTION.test(v) && !v.includes('/.github/workflows/')) && !DOCKER.test(v)) {
        return { unknown: `${path} has uses: ${v}, which is not a plain local or remote action` };
      }
    }
    const patterns = [];
    for (const [before, rest] of keyEntries(text, 'cache-dependency-path')) {
      const v = scalar(before, rest);
      if (v === null) return { unknown: `${path} has a cache-dependency-path value the line does not show` };
      patterns.push(v);
    }
    const joined = joinEscapedBreaks(text);
    for (const m of joined.matchAll(HASHFILES)) {
      const args = hashFilesArgs(joined, m.index + m[0].length);
      if (args === null) return { unknown: `${path} calls hashFiles with an argument that is not a quoted literal` };
      // @actions/glob reads each line of a pattern as its own pattern, trimmed.
      patterns.push(...args.flatMap((a) => a.split('\n').map((line) => line.trim()).filter(Boolean)));
    }
    for (const pattern of patterns) {
      if (!PLAIN_PATH.test(pattern)) return { unknown: `${path} hashes '${pattern}', which is not a plain path` };
      const verdict = judgePattern(pattern);
      if (verdict === 'unknown') return { unknown: `${path} hashes '${pattern}', which may reach a workflow file` };
      if (verdict !== 'none') files.add(verdict);
    }
  }
  return { files: [...files].sort() };
}
