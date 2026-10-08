/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure detector behind scripts/check-main-entry-guards.mjs.
 *
 * A script that decides "was I the file node was asked to run?" by comparing
 * `process.argv[1]` with its own `import.meta.url` / `import.meta.filename` /
 * `fileURLToPath(...)` by hand is wrong whenever the two disagree on spelling:
 * `import.meta.url` is symlink-resolved and percent-encoded, `argv[1]` is
 * neither. The module then falls through and the process exits 0 having done
 * nothing, which a caller reads as success. macOS makes this routine (the temp
 * dir `/var/...` is a symlink to `/private/var/...`), Linux CI hides it.
 * `scripts/lib/is-main-entry.mjs` compares realpath'd paths and is the one
 * spelling to use.
 *
 * A guard that only asks `argv[1].endsWith('name.mjs')` has no such failure
 * and is not flagged: the rule is about COMPARING `argv[1]` with the module's
 * own location. A comparison that realpaths `argv[1]` is correct and is not
 * flagged either; test files are skipped, since they may spell the naive guard
 * on purpose to demonstrate it.
 */

const ARGV = /\bargv(?:\[1\]|\.at\(1\))/;
const COMPARE = /[!=]==?/;
/** Most lines a single guard statement may span before the scan stops looking. */
const STATEMENT_LINES = 12;
/** A line that closes a statement or a block header (`;`, `{`, `}`), or is blank. */
const endsStatement = (t) => t.trim() === '' || /[;{}]\s*(?:\/\/.*)?$/.test(t.trim());
/**
 * `argv[1]` passed through a realpath call. `import.meta.url` is already
 * symlink-resolved by node, so resolving the other side is what makes the
 * comparison correct; a `realpath` that wraps only the module path (the
 * `argv[1] === realpathSync(fileURLToPath(import.meta.url))` shape) is still
 * the broken comparison and must not exempt the statement.
 */
const REALPATH_ARGV = /realpath\w*(?:\.native)?\(\s*(?:resolve\(\s*)?process\.argv/;
const SELF_LOCATION = /import\.meta\b|\bfileURLToPath\b|\bpathToFileURL\b/;

/**
 * @param {string[]} files tracked paths
 * @param {(path: string) => string} read file content reader
 * @returns {{file: string, line: number, text: string}[]}
 */
export function findHandRolledMainGuards(files, read) {
  const out = [];
  for (const file of files) {
    if (!/\.(?:[cm]?js|[cm]?ts)$/.test(file)) continue;
    if (file === 'scripts/lib/is-main-entry.mjs' || /\.test\.[cm]?[jt]sx?$/.test(file)) continue;
    const lines = read(file).split('\n');
    const isComment = (t) => /^\s*(?:\/\/|\*|\/\*)/.test(t);
    let reportedUntil = -1;
    lines.forEach((text, i) => {
      if (i <= reportedUntil || isComment(text) || !ARGV.test(text)) return;
      // A guard split over several lines (`process.argv[1] ===` / `fileURLToPath(...)`,
      // or a formatter's one-token-per-line spelling) is one statement: judge the
      // whole statement the argv line belongs to, found by its terminators.
      let lo = i;
      while (lo > 0 && i - lo < STATEMENT_LINES && !endsStatement(lines[lo - 1])) lo--;
      let hi = i;
      while (hi < lines.length - 1 && hi - i < STATEMENT_LINES && !endsStatement(lines[hi])) hi++;
      const window = lines
        .slice(lo, hi + 1)
        .filter((t) => !isComment(t))
        .join(' ');
      if (COMPARE.test(window) && SELF_LOCATION.test(window) && !/isMainEntry/.test(window) && !REALPATH_ARGV.test(window)) {
        out.push({ file, line: i + 1, text: text.trim() });
        reportedUntil = hi;
      }
    });
  }
  return out;
}
