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
 * own location. A comparison that realpaths both sides is correct and is not
 * flagged either; test files are skipped, since they may spell the naive guard
 * on purpose to demonstrate it.
 */

const ARGV = /\bargv(?:\[1\]|\.at\(1\))/;
const COMPARE = /[!=]==?/;
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
    lines.forEach((text, i) => {
      if (isComment(text) || !ARGV.test(text)) return;
      // A guard split over several lines (`process.argv[1] ===` / `fileURLToPath(...)`)
      // is one statement: judge the argv line together with its neighbours.
      const window = lines
        .slice(Math.max(0, i - 2), i + 3)
        .filter((t) => !isComment(t))
        .join(' ');
      if (COMPARE.test(window) && SELF_LOCATION.test(window) && !/isMainEntry|realpath/.test(window)) {
        out.push({ file, line: i + 1, text: text.trim() });
      }
    });
  }
  return out;
}
