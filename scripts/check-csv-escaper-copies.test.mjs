/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gate's own test. A grep gate that does not fire is worse than no gate,
 * because it reads as a guarantee — so each case below plants a copy in the
 * exact shape one of the ten real ones had and asserts the gate catches it.
 *
 * Run: `node --test scripts/check-csv-escaper-copies.test.mjs`
 */
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, scanRepo, CANONICAL, KNOWN_REMAINING } from './check-csv-escaper-copies.mjs';

/** The ten real copies this gate exists because of, in their original form. */
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
  test(`fires on an eleventh copy shaped like ${label}`, () => {
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

// ---------------------------------------------------------------------------
// Comment handling. Every case here is a shape that a PREVIOUS attempt at this
// got wrong, and each was found by planting the escaper and executing it.
//
// This block exists because attempts 1 through 4 all passed the 17 tests above.
// Two of those attempts let a live, working formula-injection escaper through
// the gate, and the suite could not tell them apart. A guard whose test cannot
// distinguish a fixed version from a broken one is not pinning anything.
//
// The MISSED cases are paired: each planted escaper is also asserted bare, so a
// probe that simply cannot match reports as a broken probe rather than a pass.
// ---------------------------------------------------------------------------
describe('comment handling', () => {
  const F = 'packages/export/src/probe.ts';
  const RS = 'rust/export/src/probe.rs';
  const bare = (src) => scanText(F, src).length;

  /** Assert a planted escaper is caught, and that the bare form CAN be caught. */
  function caught(name, bareSrc, contextSrc, file = F) {
    it(name, () => {
      assert.ok(
        scanText(file, bareSrc).length >= 1,
        `probe is incapable of matching, so the context result would be meaningless: ${name}`,
      );
      assert.ok(
        scanText(file, contextSrc).length >= 1,
        `a live escaper was hidden by its comment context: ${name}`,
      );
    });
  }

  const TS_COPY = `if (/^[=+\\-@\\t\\r]/.test(s)) s = "'" + s;`;
  const RS_COPY = `let hit = matches!(c, '=' | '+' | '-' | '@');`;

  // attempt 2 missed this: `*/` hands the rest of the line back to the compiler
  caught('/* then // */ code on one line', TS_COPY, `/* open\n// */ ${TS_COPY}`);
  // attempt 3 missed this: an unclosed `/*` inside a string set the block flag
  caught('code after a string containing /*', TS_COPY, `const s = "/* x";\n${TS_COPY}`);
  caught('code after a template literal containing /*', TS_COPY, `const t = \`/* x\`;\n${TS_COPY}`);
  // attempt 1 missed this: `*` leads a Rust deref-assign, not only a docblock
  caught('Rust deref-assign after a spurious opener', RS_COPY, `let s = "/* x";\n    *out = ${RS_COPY}`, RS);
  // attempt 4 missed this: `* ` with a space is a live JS generator method
  caught('JS generator method with a leading star', TS_COPY, `const M = '/*';\nexport const o = { * q(s) { ${TS_COPY} return s; } };`);
  // a `//` inside a string must not swallow a real `/*` later on the same line
  caught('// inside a string before a real /*', TS_COPY, `const u = 'https://x'; /* open\n// */ ${TS_COPY}`);

  it('a trailing comment never exempts the code before it', () => {
    assert.equal(bare(`const RE = /^[=+\\-@\\t\\r]/; // the anchored trigger`), 1);
  });

  // False REDs. Documenting this pattern is what a fix for it writes, so prose
  // describing it must not red the gate -- that is what redded main.
  const prose = [
    ['a line comment', '// not a formula to an anchored `/^[=+\\-@\\t\\r]/` but it is to Excel'],
    ['an indented line comment', '      // anchored `/^[=+\\-@\\t\\r]/` mention'],
    ['a docblock body', '/**\n * anchored /^[=+\\-@\\t\\r]/ described here\n */'],
    ['a one-line docblock', '/** never hand-roll /^[=+\\-@\\t\\r]/; call escapeCsvCell() */'],
    ['a block comment with no leading stars', '/*\n  do not re-test /^[=+\\-@\\t\\r]/ here\n*/'],
    ['prose sharing the closing line', '/**\n * avoid /^[=+\\-@\\t\\r]/ locally. */'],
    ['a Rust inner doc block', '/*! crate docs: never re-test /^[=+\\-@\\t\\r]/ */'],
    ['CRLF line endings', '// anchored `/^[=+\\-@\\t\\r]/` mention\r\nconst x = 1;'],
  ];
  for (const [name, src] of prose) {
    it(`prose does not red: ${name}`, () => {
      assert.equal(scanText(F, src).length, 0, `prose redded the gate: ${name}`);
    });
  }
});

// ---------------------------------------------------------------------------
// String-phase loss. These target THIS design's failure mode, not the previous
// four's.
//
// Every case above was drawn from a leading-character heuristic's mistakes, so
// none of them could have caught a tokeniser that loses string phase. A suite
// that rejects the designs you already replaced is evidence about those, not
// about the one you shipped.
//
// Root cause: an unpaired `'` in CODE -- a Rust lifetime, a JSX contraction --
// opened a fake string that ran to the next quote anywhere in the file.
// ---------------------------------------------------------------------------
describe('string phase is not lost by an unpaired quote', () => {
  const RS = 'rust/export/src/probe.rs';
  const TSX = 'apps/viewer/src/probe.tsx';
  const TS = 'packages/export/src/probe.ts';
  const PROSE = '// never re-test /^[=+\\-@\\t\\r]/ here';
  const RS_COPY = `let hit = matches!(c, '=' | '+' | '-' | '@');`;
  const TS_COPY = `if (/^[=+\\-@\\t\\r]/.test(s)) s = "'" + s;`;

  // False reds: an odd quote must not leave a later comment unblanked.
  it('a Rust lifetime does not unblank a following comment', () => {
    assert.equal(scanText(RS, `pub fn p<'a>(s: &'a str, t: &'a str) {}\n${PROSE}`).length, 0);
  });
  it('a JSX contraction does not unblank a following comment', () => {
    assert.equal(scanText(TSX, `export const M = () => <p>What's New</p>;\n${PROSE}`).length, 0);
  });
  it('a Rust raw string with an odd inner quote does not unblank a comment', () => {
    assert.equal(scanText(RS, `let r = r#"say "hi ok"#;\n${PROSE}`).length, 0);
  });
  it('a regex after a keyword does not unblank a comment', () => {
    assert.equal(scanText(TS, `function q(s) { return /["]/.test(s); }\n${PROSE}`).length, 0);
  });

  // The bypass: once phase inverts, a `//` inside a real string blanks live
  // code. Paired, so a probe that cannot match reports as broken.
  it('a URL in a string after a lifetime does not hide a Rust escaper', () => {
    assert.ok(scanText(RS, RS_COPY).length >= 1, 'probe cannot red; result meaningless');
    const ctx = `pub fn f<'a>(s: &'a str, t: &'a str) {\n    let m = "can't parse";\n    let u = "http://x"; ${RS_COPY}\n}`;
    assert.ok(scanText(RS, ctx).length >= 1, 'a live Rust escaper was hidden by string-phase loss');
  });
  it('a URL in a string after a keyword-regex does not hide a TS escaper', () => {
    assert.ok(scanText(TS, TS_COPY).length >= 1, 'probe cannot red; result meaningless');
    const ctx = `function q(s) { return /["]/.test(s); }\nconst u = "http://x"; ${TS_COPY}`;
    assert.ok(scanText(TS, ctx).length >= 1, 'a live TS escaper was hidden by string-phase loss');
  });

  // Coverage the earlier block never gave: the match-arm pattern is the one
  // built out of apostrophes, so it is the most entangled with string state.
  it('prose describing the Rust match arm does not red', () => {
    assert.equal(scanText(RS, `// never write matches!(c, '=' | '+' | '-' | '@') by hand`).length, 0);
  });
});
