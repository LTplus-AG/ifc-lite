/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The workflow files a workflow run can read: those its executed files NAME.
 * Used by ci-push-replay.mjs, where every `.github/actions/` file blocks a
 * replay anyway, so this answers one narrower question: which top-level
 * workflow YAML files can feed Test? A file nothing executed names cannot.
 *
 * The executed files are the root workflow, every file under
 * `.github/actions/` (action.yml and the scripts beside it), and each reusable
 * workflow the root calls with `uses:`. A mention in any of them counts, in any
 * syntax; a mention in a workflow Test does not execute (a path filter naming
 * docs.yml puts docs.yml on the list) is not scanned further. The patterns
 * below return null (block everything) for the dynamic references they
 * recognise. It is a text match, not a proof: repo scripts are not scanned,
 * and a reference built another way is missed (see ci-push-replay.mjs).
 */

// A name ends at its extension or at a sentence's full stop: `x.yml.disabled` is not `x.yml`.
const WORKFLOW_REF = /\.github\/workflows\/[\w.-]+?\.ya?ml(?![\w-]|\.[\w-])/g;
const USES_WORKFLOW = /uses:\s*['"]?\.\/(\.github\/workflows\/[\w.-]+?\.ya?ml)(?![\w-]|\.[\w-])/g;
// References the scan cannot list, so the result is unknown:
// - a workflows path built from an expression or variable (`workflows/${{`, `workflows/$X`);
// - the directory itself, which `cd`, `working-directory` or `"…/workflows/"$X` builds on;
// - a single-star glob (`workflows/*.yml`); a path filter's `workflows/**` only selects lanes;
// - `hashFiles` over `.github` or a repo-wide pattern starting `**`, which can put a workflow file in a cache key.
const UNFOLLOWABLE = new RegExp([
  /\.github\/workflows\/[\w./-]*\$/.source,
  /\.github\/workflows(?:\/(?![\w.*-])|(?![\w\/.-]))/.source,
  /\.github\/workflows\/[\w./-]*\*(?!\*)/.source,
  /hashFiles\([^)]*(?:\.github|['"]\*\*)/.source,
].join('|'));

/**
 * @param {{
 *   root: string,
 *   actionFiles: string[] | null,
 *   readText: (path: string) => string | null,
 * }} input `root` is the workflow, e.g. `.github/workflows/test.yml`; `actionFiles`
 *   every file under `.github/actions/` at the commit, null when unlisted;
 *   `readText` a file's text at the commit, null when absent.
 * @returns {string[] | null} the named workflow files, `root` included, sorted;
 *   null when a file cannot be listed or read, or holds a reference the scan cannot follow.
 */
export function namedWorkflowFiles({ root, actionFiles, readText }) {
  if (!Array.isArray(actionFiles)) return null;
  const named = new Set([root]);
  const executed = [root, ...actionFiles];
  for (let i = 0; i < executed.length; i += 1) {
    const text = readText(executed[i]);
    if (typeof text !== 'string' || UNFOLLOWABLE.test(text)) return null;
    for (const [ref] of text.matchAll(WORKFLOW_REF)) named.add(ref);
    for (const [, ref] of text.matchAll(USES_WORKFLOW)) {
      if (!executed.includes(ref)) executed.push(ref);
    }
  }
  return [...named].sort();
}
