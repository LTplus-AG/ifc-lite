/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The local `.github/` files a workflow reads, found by scanning its text and
 * the text of every local action and workflow it names. Used by
 * ci-push-replay.mjs to decide which workflow edits re-key Test's caches.
 * Every way the scan can be wrong is meant to be wrong towards null (block).
 */

// Any mention, not only a block-style `uses:` line: a flow mapping, a quoted
// key, `run: node $GITHUB_WORKSPACE/.github/actions/x/y.mjs` and a comment all
// count. Naming a file Test does not run over-blocks (a path filter names
// docs.yml); that only costs a full run. A sentence's full stop is not part of a name.
const GITHUB_REF = /\.github\/(?:actions\/[\w-]+(?:\.[\w-]+)*|workflows\/[\w.-]+\.ya?ml)/g;
// A remote `uses: owner/repo/.github/...@ref` names another repository's file. Only
// that full shape is skipped: a bare `owner/repo/` token right before, and `@` right after.
const REMOTE_OWNER_REPO = /(?:^|[\s'"])[\w-]+\/[\w.-]+\/$/;
// What the scan cannot follow: a path climbing out of an action's own directory, or a
// `.github/` path built from an expression or variable. Either makes the list unknown.
const UNFOLLOWABLE = /\b(?:GITHUB_ACTION_PATH|github\.action_path)\b[^\n]{0,8}?\/\.\.|\.github\/(?:actions|workflows)\/[\w./-]*\$/;

function isRemoteRef(text, m) {
  const lineStart = text.lastIndexOf('\n', m.index) + 1;
  return text[m.index + m[0].length] === '@' && REMOTE_OWNER_REPO.test(text.slice(lineStart, m.index));
}

/**
 * The `.github/` paths a workflow run reads: `root` and every local action or
 * workflow file it names, transitively. An action is returned as its directory
 * with a trailing `/`, since its scripts ship with it. `readText(path)` returns
 * the file at the push commit, or null when it does not exist. Returns null
 * when `root` or any file it reaches cannot be read, or holds a reference the
 * scan cannot follow (UNFOLLOWABLE), so the caller blocks every workflow and
 * action file rather than guess.
 *
 * @param {string} root the workflow file, e.g. `.github/workflows/test.yml`
 * @param {(path: string) => string | null} readText
 * @returns {string[] | null}
 */
export function workflowFileClosure(root, readText) {
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const path = queue.shift();
    const text = path.endsWith('/') ? readText(`${path}action.yml`) ?? readText(`${path}action.yaml`) : readText(path);
    if (typeof text !== 'string' || UNFOLLOWABLE.test(text)) return null;
    for (const m of text.matchAll(GITHUB_REF)) {
      if (isRemoteRef(text, m)) continue;
      const ref = m[0];
      const next = ref.startsWith('.github/actions/') ? `${ref}/` : ref;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].sort();
}
