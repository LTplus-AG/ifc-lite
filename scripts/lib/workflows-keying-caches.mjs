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
 * Every hashFiles call must therefore be judged. An argument that is not a
 * quoted literal, or a wildcard pattern that could reach
 * `.github/workflows/<x>.yml`, makes the answer unknown. A key built in a `run:`
 * step from a workflow file's bytes is not detected; no such step exists.
 */

const LOCAL_USES = /uses:\s*['"]?\.\/(\.github\/workflows\/[^\s'"@#]+)/g;
const REMOTE_WORKFLOW_USES = /uses:\s*['"]?[\w-]+\/[\w.-]+\/\.github\/workflows\//;
const HASHFILES = /hashFiles\(/g;
const QUOTED_ARG = /^\s*(?:'([^']*)'|"([^"]*)")\s*([,)])/;
const WORKFLOWS_DIR = '.github/workflows/';

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

/** For one pattern: the workflow file it names, 'none', or 'unknown' (a wildcard that may reach one). */
function judgePattern(pattern) {
  const p = pattern.replace(/^\.\//, '');
  const wild = p.search(/[*?[{!]/);
  if (wild < 0) {
    return p.startsWith(WORKFLOWS_DIR) && !p.slice(WORKFLOWS_DIR.length).includes('/') ? p : 'none';
  }
  const prefix = p.slice(0, wild);
  // The literal part before the first wildcard rules the directory in or out.
  if (prefix.length > 0 && !WORKFLOWS_DIR.startsWith(prefix) && !prefix.startsWith(WORKFLOWS_DIR)) return 'none';
  // In or above .github/workflows/: unknown unless its last segment cannot be a YAML file
  // (one that only reaches deeper files is fine: those always block on their own).
  const last = p.slice(p.lastIndexOf('/') + 1);
  return /[*?[{]/.test(last) || /\.ya?ml$/.test(last) ? 'unknown' : 'none';
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
    for (const m of text.matchAll(HASHFILES)) {
      const args = hashFilesArgs(text, m.index + m[0].length);
      if (args === null) return { unknown: `${path} calls hashFiles with an argument that is not a quoted literal` };
      for (const pattern of args) {
        const verdict = judgePattern(pattern);
        if (verdict === 'unknown') return { unknown: `${path} hashes '${pattern}', which may match a workflow file` };
        if (verdict !== 'none') files.add(verdict);
      }
    }
  }
  return { files: [...files].sort() };
}
