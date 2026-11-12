/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The top-level workflow files whose edit can change a Test cache key, so a
 * push touching one must still run in full on main (ci-push-replay.mjs).
 *
 * A workflow file reaches a cache key in one of two ways: it is executed by the
 * run (test.yml, or a reusable workflow test.yml calls with `uses: ./...`), so
 * its own text sets keys; or a `hashFiles(...)` in an executed file hashes it.
 * Executed files are those workflows plus every file under `.github/actions/`
 * (which ci-push-replay blocks on its own). A step that merely READS another
 * workflow is test behaviour, already covered by the exact-tree evidence.
 *
 * Every hashFiles argument and `cache-dependency-path` value must therefore be
 * judged. One that is not a plain literal, or a pattern that could reach
 * `.github/workflows/<x>.yml` without naming it (a wildcard, or a directory,
 * whose files hashFiles all hashes), makes the answer unknown. A key built in a
 * `run:` step from a workflow file's bytes, or by another remote action's
 * input, is not detected.
 */

import { posix } from 'node:path';

const LOCAL_USES = /uses:\s*['"]?\.\/(\.github\/workflows\/[^\s'"@#]+)/g;
const REMOTE_WORKFLOW_USES = /uses:\s*['"]?[\w-]+\/[\w.-]+\/\.github\/workflows\//;
// Expression function names are case-insensitive.
const HASHFILES = /hashFiles\(/gi;
const QUOTED_ARG = /^\s*(?:'([^']*)'|"([^"]*)")\s*([,)])/;
// An action input whose files key a cache (actions/setup-node, setup-python, ...).
const CACHE_DEPENDENCY_PATH = /cache-dependency-path:[ \t]*(.*)$/gim;
// One scalar, ending the line or a flow-mapping entry (`, ...` / ` }`). A block scalar (`|`, `>`) is not plain.
const PLAIN_VALUE = /^(?:'([^']*)'|"([^"]*)"|([^\s'"#|>,}][^\s#,}]*))\s*(?:[,}].*)?(?:#.*)?$/;
const WORKFLOW_SEGMENTS = ['.github', 'workflows'];

/** A hashFiles call's literal arguments, or null when one is not a quoted literal. */
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

const isWild = (seg) => /[*?[\]{}!]/.test(seg);

/** Whether one glob segment can match target segment `ti` (0 `.github`, 1 `workflows`, 2 any YAML name). */
function segmentMatches(seg, ti) {
  if (ti === 2) return isWild(seg) || /\.ya?ml$/.test(seg);
  if (!isWild(seg)) return seg === WORKFLOW_SEGMENTS[ti];
  if (/[[\]{}!]/.test(seg)) return true;
  const re = new RegExp(`^${seg.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(WORKFLOW_SEGMENTS[ti]);
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

/** For one pattern: the workflow file it names, 'none', or 'unknown' (it may reach one it does not name). */
function judgePattern(pattern) {
  if (pattern.startsWith('!')) return 'none';
  const p = posix.normalize(pattern);
  // The workspace root, or an absolute path that may be it: everything below is hashed.
  if (p === '.' || p === './' || p.startsWith('/')) return 'unknown';
  const segs = p.replace(/\/$/, '').split('/');
  if (!reachesWorkflows(segs)) return 'none';
  return segs.length === 3 && !segs.some(isWild) ? p : 'unknown';
}

/** The patterns a `cache-dependency-path:` input lists, or null when its value is not a plain scalar. */
function cacheDependencyPaths(text) {
  const out = [];
  for (const m of text.matchAll(CACHE_DEPENDENCY_PATH)) {
    const v = PLAIN_VALUE.exec(m[1].trim());
    if (!v) return null;
    out.push(v[1] ?? v[2] ?? v[3]);
  }
  return out;
}

/**
 * @param {{
 *   root: string,
 *   actionFiles: string[] | null,
 *   readText: (path: string) => string | null,
 * }} input `root` is `.github/workflows/test.yml`; `actionFiles` every file under
 *   `.github/actions/` at the commit (null when unlisted); `readText` a file's
 *   text at the commit (null when absent).
 * @returns {{ files: string[] } | { unknown: string }} the sorted workflow files
 *   that key Test's caches, `root` included, or why that cannot be told.
 */
export function workflowsKeyingCaches({ root, actionFiles, readText }) {
  if (!Array.isArray(actionFiles)) return { unknown: 'the .github/actions/ files could not be listed' };
  const files = new Set([root]);
  const executed = [root, ...actionFiles];
  for (let i = 0; i < executed.length; i += 1) {
    const path = executed[i];
    const text = readText(path);
    if (typeof text !== 'string') return { unknown: `${path} could not be read` };
    if (REMOTE_WORKFLOW_USES.test(text)) return { unknown: `${path} calls a reusable workflow by owner/repo` };
    for (const [, ref] of text.matchAll(LOCAL_USES)) {
      files.add(ref);
      if (!executed.includes(ref)) executed.push(ref);
    }
    const patterns = cacheDependencyPaths(text);
    if (patterns === null) return { unknown: `${path} sets cache-dependency-path to a value that is not a plain path` };
    for (const m of text.matchAll(HASHFILES)) {
      const args = hashFilesArgs(text, m.index + m[0].length);
      if (args === null) return { unknown: `${path} calls hashFiles with an argument that is not a quoted literal` };
      patterns.push(...args);
    }
    for (const pattern of patterns) {
      const verdict = judgePattern(pattern);
      if (verdict === 'unknown') return { unknown: `${path} hashes '${pattern}', which may reach a workflow file` };
      if (verdict !== 'none') files.add(verdict);
    }
  }
  return { files: [...files].sort() };
}
