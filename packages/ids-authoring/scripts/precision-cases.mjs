/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The precision corpus: buildingSMART pass-/fail- cases (read-only, CC BY-ND)
 * plus the internal lint corpus. Shared by scripts/lint-precision.mjs and
 * the package test; dependencies are injected so the test can run it too.
 */

/** Types: ./precision-cases.d.mts */
export function loadPrecisionCases(pkgDir, { parseIDS, readdirSync, readFileSync, join }) {
  const out = [];
  const bsi = join(pkgDir, '../ids/src/__corpus__/buildingsmart-ids');
  for (const dir of readdirSync(bsi, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(bsi, dir.name))) {
      if (!f.endsWith('.ids') || !(f.startsWith('pass-') || f.startsWith('fail-'))) continue;
      out.push({ file: `buildingsmart/${dir.name}/${f}`, ids: parseIDS(readFileSync(join(bsi, dir.name, f), 'utf8')) });
    }
  }
  const internal = join(pkgDir, 'test/lint-corpus');
  for (const f of readdirSync(internal)) {
    if (f.endsWith('.ids')) out.push({ file: `internal/${f}`, ids: parseIDS(readFileSync(join(internal, f), 'utf8')) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
