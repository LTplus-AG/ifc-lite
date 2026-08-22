/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gate's own test. A grep gate that does not fire is worse than no gate,
 * because it reads as a guarantee — so each case below plants a copy in the
 * exact shape one of the nine real ones had and asserts the gate catches it.
 *
 * Run: `node --test scripts/check-csv-escaper-copies.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, scanRepo, CANONICAL, KNOWN_REMAINING } from './check-csv-escaper-copies.mjs';

/** The nine real copies this gate exists because of, in their original form. */
const REAL_COPIES = [
  ['rust/export/src/csv.rs (anchored Rust guard)', "if matches!(first, '=' | '+' | '-' | '@' | '\\t' | '\\r') {"],
  ['packages/cli/src/commands/export.ts (anchored TS guard)', 'if (/^[=+\\-@\\t\\r]/.test(str)) {'],
  ['packages/cli/src/headless-backend.ts', 'if (/^[=+\\-@\\t\\r]/.test(str)) {'],
  ['packages/mcp/src/headless-backend.ts', 'if (/^[=+\\-@\\t\\r]/.test(str)) {'],
  ['apps/viewer/src/sdk/adapters/export-adapter.ts', `if (/^[=+\\-@\\t\\r]/.test(value)) value = \`'\${value}\`;`],
  ['packages/sdk/src/namespaces/export.ts (the hardened one)', 'if (/^[\\p{Cf}\\p{Zs}]*[=+\\-@\\t\\r]/u.test(str)) {'],
  ['apps/viewer/src/lib/lists/export/model.ts', `return /^[=+\\-@\\t\\r]/.test(s) ? \`'\${s}\` : s;`],
  ['apps/viewer/src/lib/search/result-export.ts', `if (/^[=+\\-@\\t\\r]/.test(raw)) raw = \`'\${raw}\`;`],
  ['apps/viewer/src/lib/compare/exportReport.ts', `return /[",\\r\\n]/.test(s) ? \`"\${s.replace(/"/g, '""')}"\` : s;`],
  ['apps/viewer/src/lib/zones/table.ts (quoting only)', `? \`"\${text.replace(/"/g, '""')}"\``],
];

for (const [label, line] of REAL_COPIES) {
  test(`fires on a tenth copy shaped like ${label}`, () => {
    const hits = scanText('apps/viewer/src/lib/some/new-export.ts', `function esc(s) {\n  ${line}\n}\n`);
    assert.ok(hits.length > 0, `gate missed a copy shaped like: ${line}`);
    assert.equal(hits[0].file, 'apps/viewer/src/lib/some/new-export.ts');
    assert.equal(hits[0].line, 2, 'reports the offending line number');
  });
}

test('fires on a Rust copy in a brand-new crate', () => {
  const hits = scanText(
    'rust/newthing/src/out.rs',
    "fn esc(v: &str) -> String {\n    if matches!(c, '=' | '+' | '-') { }\n}\n",
  );
  assert.ok(hits.length > 0);
});

test('does not fire on the canonical implementations', () => {
  for (const c of CANONICAL) {
    const hits = scanText(c, `if (/^[=+\\-@\\t\\r]/.test(s)) return \`'\${s}\`;\nreturn s.replace(/"/g, '""');\n`);
    assert.deepEqual(hits, [], `${c} must be allowed to contain the guard — it IS the guard`);
  }
});

test('does not fire on ordinary code that merely mentions CSV', () => {
  const hits = scanText(
    'apps/viewer/src/lib/thing.ts',
    "// Export as CSV with a comma delimiter.\nconst out = rows.map((r) => escapeCsvCell(r, { delimiter: ',' })).join('\\r\\n');\n",
  );
  assert.deepEqual(hits, []);
});

test('a hand-rolled copy is caught even when the canonical name appears in the same file', () => {
  // The failure mode this rules out: someone imports the shared escaper for one
  // column and hand-rolls another next to it, and a "does the file mention
  // escapeCsvCell?" check would wave it through.
  const hits = scanText(
    'packages/cli/src/commands/other.ts',
    `import { escapeCsvCell } from '@ifc-lite/export';\nconst quick = (s) => (/^[=+\\-@\\t\\r]/.test(s) ? \`'\${s}\` : s);\n`,
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

test('refuses to pass vacuously when the file scan returns almost nothing', () => {
  // An empty grep is indistinguishable from a clean repo unless the gate
  // checks that it actually looked at something.
  assert.throws(
    () => scanRepo(['a.ts'], () => ''),
    /suspiciously small file list/,
    'a broken scan must fail, not report clean',
  );
});

test('the repo currently has no NEW copies, and every KNOWN_REMAINING entry is still real', () => {
  const { violations, staleKnown, scanned } = scanRepo();
  assert.ok(scanned > 1000, `expected a real scan, got ${scanned} files`);
  assert.deepEqual(violations, [], 'a new hand-rolled CSV escaper was added');
  assert.deepEqual(
    staleKnown,
    [],
    'KNOWN_REMAINING is a ratchet: an entry that no longer hand-rolls an escaper must be deleted from the list',
  );
});

test('KNOWN_REMAINING is documented debt, not an open allowlist', () => {
  // A guard on the guard: if this list starts growing, the gate has become a
  // place to register new copies rather than a reason not to write them.
  assert.ok(
    KNOWN_REMAINING.length <= 1,
    `KNOWN_REMAINING must shrink, never grow; it now holds ${KNOWN_REMAINING.length}: ${KNOWN_REMAINING.join(', ')}`,
  );
});
