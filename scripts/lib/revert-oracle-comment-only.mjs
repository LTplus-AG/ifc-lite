/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A diff whose every changed line is a JS/TS comment line changes no runtime
 * behaviour at all, so no test can ever observe it -- the same reason
 * `isVersionOnlyManifestDiff` exists for a version-literal bump (#4165: PR
 * #4165 added a paragraph to a comment above `INERT_SUFFIXES` in
 * `revert-oracle-inert.mjs` documenting *why* `.svg` stays inert, changed
 * nothing else, and `check-test-revert-oracle.mjs` correctly reported
 * UNOBSERVED after a test file was added to the branch -- reverting a comment
 * cannot make any test go red, by construction, so no test could ever satisfy
 * that run other than by accident).
 *
 * DELIBERATELY NARROW, same shape as the version-bump module: only a line
 * whose TRIMMED text is empty, or starts with `//`, `/*`, or `*` (a JSDoc
 * continuation / block-comment closer) counts as a comment line. A line that
 * mixes real code with a trailing `// comment` does NOT match -- it does not
 * start with one of those tokens -- so `x = 1; // note` still counts as code,
 * which is the direction that must fail closed: false positives here would
 * let a genuine, unobserved behaviour change slip past the oracle silently,
 * exactly the defect this whole tool exists to catch. False negatives (a
 * would-be comment-only diff that this fails to recognize, e.g. one that puts
 * code and `/*` on the same line) just mean the branch still needs a real
 * test, which is the safe direction.
 *
 * Scoped to the extensions where `//`/`/*` is the comment syntax; Rust and
 * Python files are not covered.
 *
 * Pure function over diff text, same shape as `revert-oracle-version-bump.mjs`.
 */

const COMMENT_SYNTAX_EXTS = ['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx'];

function isCommentLine(line) {
  const t = line.trim();
  return t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

/**
 * @param {string} path repo-relative path of the changed file
 * @param {string} diffText `git diff -U0 <base> <head> -- <path>` output
 * @returns {boolean} true only if the file has a JS/TS comment syntax AND
 *   every added/removed line (across every hunk) is blank or a comment line.
 *   A diff with no changed lines at all (e.g. a pure rename) is NOT
 *   comment-only -- there is nothing here to certify as inert prose.
 */
export function isCommentOnlyDiff(path, diffText) {
  if (!COMMENT_SYNTAX_EXTS.some((ext) => path.endsWith(ext))) return false;
  const changed = [];
  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('-') || line.startsWith('+')) changed.push(line.slice(1));
  }
  if (changed.length === 0) return false;
  return changed.every(isCommentLine);
}
