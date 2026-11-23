/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The output to scan for load errors. When tests ran and failed, that is only
 * the failing tests' own error text: product code may log load-error text
 * beside an ordinary assertion failure (#11256). A file-level load failure,
 * or a family with no failure section, scans the whole output.
 *
 * @param {string} family runner family
 * @param {string} text combined runner output
 * @param {{failed: number|null, loadEvidence?: string|null}} parsed
 * @returns {string}
 */
export function loadErrorScope(family, text, parsed) {
  return (parsed.failed > 0 && !parsed.loadEvidence && failureText(family, text)) || text;
}

function failureText(family, text) {
  if (family === 'vitest') {
    // The failing tests' errors follow the `Failed Tests` banner; logs precede it.
    const banner = /⎯ Failed Tests \d+ ⎯/.exec(text);
    return banner ? text.slice(banner.index) : null;
  }
  if (family === 'node-test') {
    // Each failing subtest's YAML block (`not ok` through the `...` at its own
    // indent, not one inside an assert diff) holds its error; `#` lines are logs.
    const blocks = [...text.matchAll(/^([ \t]*)not ok \d+ - .*$[\s\S]*?^\1 {2}\.\.\.[ \t]*$/gm)].map((b) => b[0]);
    return blocks.length > 0 ? blocks.join('\n') : null;
  }
  return null;
}
