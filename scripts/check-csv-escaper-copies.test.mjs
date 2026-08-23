/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gate's own test. A grep gate that does not fire is worse than no gate,
 * because it reads as a guarantee — so each case below plants a copy in the
 * exact shape one of the ten real ones had and asserts the gate catches it.
 *
 * Every planted escaper is PAIRED with the same escaper bare: a probe that
 * cannot match in the first place reports as a broken probe, not as a pass.
 *
 * Run: `node --test scripts/check-csv-escaper-copies.test.mjs`
 */
import { test, describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as gate from './check-csv-escaper-copies.mjs';

const { scanText, scanRepo, CANONICAL, KNOWN_REMAINING, PROSE_MENTIONS, validateMentions } = gate;

/**
 * Drive scanRepo with synthetic file contents. Real repo files not named in
 * `overrides` read as empty; padding files satisfy the vacuous-scan guard.
 */
function repoWith(overrides, mentions) {
  const pad = Array.from({ length: 120 }, (_, i) => `packages/pad/src/p${i}.ts`);
  const files = [...new Set([...Object.keys(overrides), ...pad])];
  return scanRepo(files, (f) => overrides[f] ?? '', mentions);
}

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

test('the canonical implementations are exempt at repo level', () => {
  const guard = `if (/^[=+\\-@\\t\\r]/.test(s)) return \`'\${s}\`;\nreturn s.replace(/"/g, '""');\n`;
  const { violations } = repoWith(Object.fromEntries(CANONICAL.map((c) => [c, guard])));
  assert.deepEqual(violations, [], 'the canonical files ARE the guard and must be allowed to contain it');
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

test('the repo currently has no NEW copies, and every ratchet entry is still real', () => {
  const { violations, staleKnown, staleMentions, scanned } = scanRepo();
  assert.ok(scanned > 1000, `expected a real scan, got ${scanned} files`);
  assert.deepEqual(violations, [], 'a new hand-rolled CSV escaper was added');
  assert.deepEqual(
    staleKnown,
    [],
    'KNOWN_REMAINING is a ratchet: an entry that no longer hand-rolls an escaper must be deleted from the list',
  );
  assert.deepEqual(
    staleMentions,
    [],
    'PROSE_MENTIONS is a ratchet: a registered comment line that no longer exists must be deleted from the list',
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
// No context hides code. Six previous designs excused comment-shaped text and
// each shipped a live, working escaper made invisible — every case here is one
// of those proven holes, plus the shapes THIS design would be weakest against
// if it ever regressed toward context-awareness. The scan is raw and per-line,
// so all of these hold by construction; the tests pin that construction.
// ---------------------------------------------------------------------------
describe('no context hides a live escaper', () => {
  const F = 'packages/export/src/probe.ts';
  const RS = 'rust/export/src/probe.rs';

  /** Assert a planted escaper is caught, and that the bare form CAN be caught. */
  function caught(name, bareSrc, contextSrc, file = F) {
    it(name, () => {
      assert.ok(
        scanText(file, bareSrc).length >= 1,
        `probe is incapable of matching, so the context result would be meaningless: ${name}`,
      );
      assert.ok(
        scanText(file, contextSrc).length >= 1,
        `a live escaper was hidden by its context: ${name}`,
      );
    });
  }

  const TS_COPY = `if (/^[=+\\-@\\t\\r]/.test(s)) s = "'" + s;`;
  const RS_COPY = `let hit = matches!(c, '=' | '+' | '-' | '@');`;

  // attempt 1's holes: `*`-leading live code
  caught('Rust deref-assign with a leading star', RS_COPY, `    *out = ${RS_COPY}`, RS);
  caught('block comment sharing a line with code', TS_COPY, `/* c */ ${TS_COPY}`);
  // attempt 2's hole: `*/` hands the rest of the line back to the compiler
  caught('/* then // */ code on one line', TS_COPY, `/* open\n// */ ${TS_COPY}`);
  // attempt 3's hole: an unclosed `/*` inside a string set the block flag
  caught('code after a string containing /*', TS_COPY, `const s = "/* x";\n${TS_COPY}`);
  caught('code after a template literal containing /*', TS_COPY, `const t = \`/* x\`;\n${TS_COPY}`);
  // attempt 4's hole: `* ` with a space is a live JS generator method
  caught('JS generator method with a leading star', TS_COPY, `const M = '/*';\nexport const o = { * q(s) { ${TS_COPY} return s; } };`);
  // attempt 5's hole: an unpaired quote in code lost string phase
  caught('escaper after a Rust lifetime and a URL string', RS_COPY,
    `pub fn f<'a>(s: &'a str) -> bool {\n    let u = "http://x"; ${RS_COPY}\n}`, RS);
  caught('escaper after a JSX contraction', TS_COPY,
    `export const M = () => <p>What's New</p>;\n${TS_COPY}`, 'apps/viewer/src/probe.tsx');
  // attempt 6's holes: a multi-line Rust string re-opened comment state, and
  // member-access `.in / bytes.out` was taken for a regex
  caught('escaper after a multi-line Rust string containing /*', RS_COPY,
    `let sql = "SELECT a\n  FROM t /* hint\n  WHERE b";\n${RS_COPY}`, RS);
  caught('escaper after member-access division', TS_COPY,
    `const ratio = bytes.in / bytes.out;\n${TS_COPY}`);
  // shapes THIS design must never lose: definition split from use — the
  // canonical implementation itself writes this form (csv-cell.ts line 49),
  // so any adjacency or usage-context rule would miss a real copy
  caught('regex defined on its own line, used elsewhere', 'const FORMULA_RE = /^[=+\\-@\\t\\r]/;',
    `const FORMULA_RE = /^[=+\\-@\\t\\r]/;\n// ...\nfunction esc(c) { return FORMULA_RE.test(c) ? "'" + c : c; }`);
  caught('escaper built via new RegExp from a string', `const re = new RegExp('^[=+\\\\-@\\\\t\\\\r]');`,
    `const re = new RegExp('^[=+\\\\-@\\\\t\\\\r]');\nif (re.test(v)) v = "'" + v;`);
  // a `//`-leading line that EXECUTES via template interpolation: the one way
  // a line-comment marker fronts live code, and why `${` is banned in mentions
  caught('escaper inside template interpolation on a //-leading line', TS_COPY,
    `let hit; const log = \`\n// \${(hit = /^[=+\\-@\\t\\r]/.test(cell))}\n\`;\nif (hit) cell = "'" + cell;`);

  it('a trailing comment never exempts the code before it', () => {
    assert.equal(scanText(F, `const RE = /^[=+\\-@\\t\\r]/; // the anchored trigger`).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Prose policy. Comments quoting a pattern DO match the raw scan — that is the
// price of a scan nothing can hide from — and are excused one exact line at a
// time via PROSE_MENTIONS, ratcheted like KNOWN_REMAINING.
// ---------------------------------------------------------------------------
describe('prose mentions', () => {
  // Fixtures, NOT the live registry. Binding these to PROSE_MENTIONS by position
  // coupled every case below to how many entries the registry happened to hold:
  // #3107 reworded the line one entry pinned, the entry was deleted, and all
  // seven cases broke for a reason unrelated to what they test. The real
  // registry is still exercised, by `validateMentions()` and by the
  // regex-source case at the end of this block.
  const MENTION = {
    file: 'packages/lists/src/fixture-doc.test.ts',
    text: '// is not a formula to an anchored `/^[=+\\-@\\t\\r]/` but it is one to Excel.',
  };
  // Bound by FILE, not by position, so it says WHICH entry it wants rather than
  // WHERE it sits. `[ENGINE_MENTION] = PROSE_MENTIONS` binds to index 0, which
  // means any registry edit re-points it -- and the registry is a ratchet whose
  // whole job is to change.
  //
  // Not claiming this prevents a SILENT failure: a prepended decoy reds the
  // positional form too (6 tests), and the probe that suggested otherwise was
  // confounded -- the decoy named an absent file, so both arms were measuring
  // the stale-mention ratchet rather than the binding. What this buys is one
  // named assertion instead of six cascading ones, and a bind that survives
  // reordering.
  const ENGINE_MENTION = PROSE_MENTIONS.find((m) => m.file === KNOWN_REMAINING[0]);
  const MENTIONS = [MENTION, ENGINE_MENTION];
  // A FIXTURE, not code: this is what `engine.ts` looks like to the scanner, so
  // the `${` has to survive verbatim into the scanned text. oxlint's
  // no-template-curly-in-string is right about the general case and wrong about
  // a fixture whose whole job is to be the source text of something else.
  const ENGINE_CODE =
    '      /^[\\p{Cf}\\p{Z}]*[=+\\-@\\t\\r]/u.test(str) &&\n' +
    // oxlint-disable-next-line no-template-curly-in-string
    '      return `"${str.replace(/"/g, \'""\')}"`;\n';

  // Both guards live in `before()`, NOT in the describe body, and that is the
  // whole point rather than a style choice. On node 22 -- which is what CI runs
  // -- a throw from a describe BODY is recorded as a failed suite and `node
  // --test` still exits 0. It prints `not ok` into the log of a green job,
  // which is precisely the absence-reads-as-success mode this gate exists to
  // kill. From a `before()` hook the same throw exits 1 and the cases report as
  // cancelled: one cause, no cascade of six mysteries. Measured on v22.14.0:
  // describe-body assert -> exit 0, before() hook assert -> exit 1.
  before(() => {
    // Guard first: if this entry is missing, the probe below would dereference
    // `.file` on undefined and report a TypeError instead of the real cause.
    assert.ok(
      ENGINE_MENTION,
      `no PROSE_MENTIONS entry for ${KNOWN_REMAINING[0]}; these cases pin its interaction with the debt ratchet`,
    );
    // The same paired probe its siblings carry below. Every case here feeds
    // ENGINE_CODE in as engine.ts's body and then asserts something about the
    // OTHER file, so an inert ENGINE_CODE would leave all of them green:
    // neutering it to `return str;` passed 46/46 before this existed.
    assert.ok(
      scanText(ENGINE_MENTION.file, ENGINE_CODE).length >= 1,
      'ENGINE_CODE no longer reads as an escaper; every case using it is vacuous',
    );
  });

  it('the registered line, in its registered file, does not red', () => {
    const { violations, staleMentions } = repoWith({
      [MENTION.file]: `const TRIGGERS = ['=', '+'];\n${MENTION.text}\n`,
      [ENGINE_MENTION.file]: `    ${ENGINE_MENTION.text}\n${ENGINE_CODE}`,
    }, MENTIONS);
    assert.deepEqual(violations, []);
    assert.deepEqual(staleMentions, []);
  });

  it('the same registered line in a DIFFERENT file reds — excusal is file-scoped', () => {
    const { violations } = repoWith({
      'packages/export/src/other.ts': `${MENTION.text}\n`,
      [MENTION.file]: `${MENTION.text}\n`,
      [ENGINE_MENTION.file]: `${ENGINE_MENTION.text}\n${ENGINE_CODE}`,
    }, MENTIONS);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'packages/export/src/other.ts');
  });

  it('a registered mention does not excuse an escaper elsewhere in the same file', () => {
    const copy = `const quick = (s) => (/^[=+\\-@\\t\\r]/.test(s) ? \`'\${s}\` : s);`;
    assert.ok(scanText(MENTION.file, copy).length >= 1, 'probe cannot match; result meaningless');
    const { violations } = repoWith({
      [MENTION.file]: `${MENTION.text}\n${copy}\n`,
      [ENGINE_MENTION.file]: `${ENGINE_MENTION.text}\n${ENGINE_CODE}`,
    }, MENTIONS);
    assert.equal(violations.length, 1, 'the escaper next to the registered comment must still red');
    assert.equal(violations[0].file, MENTION.file);
  });

  it('code sharing the line with a registered mention changes the text and reds', () => {
    const line = `if (/^[=+\\-@\\t\\r]/.test(s)) s = "'" + s; ${MENTION.text}`;
    assert.ok(scanText(MENTION.file, line).length >= 1, 'probe cannot match; result meaningless');
    const { violations } = repoWith({
      [MENTION.file]: `${MENTION.text}\n${line}\n`,
      [ENGINE_MENTION.file]: `${ENGINE_MENTION.text}\n${ENGINE_CODE}`,
    }, MENTIONS);
    assert.equal(violations.length, 1);
  });

  it('unregistered prose reds — the registry does not generalise', () => {
    const { violations } = repoWith({
      'packages/export/src/newdoc.ts': '// never hand-roll the anchored `/^[=+\\-@\\t\\r]/` guard\n',
      [MENTION.file]: `${MENTION.text}\n`,
      [ENGINE_MENTION.file]: `${ENGINE_MENTION.text}\n${ENGINE_CODE}`,
    }, MENTIONS);
    assert.equal(violations.length, 1, 'a new prose mention must be registered, not silently excused');
  });

  it('a registered line that disappears is stale and fails the gate', () => {
    const { staleMentions } = repoWith({
      [MENTION.file]: 'const nothing = 1;\n',
      [ENGINE_MENTION.file]: `${ENGINE_MENTION.text}\n${ENGINE_CODE}`,
    }, MENTIONS);
    assert.deepEqual(staleMentions, [MENTION]);
  });

  it('KNOWN_REMAINING liveness rests on CODE, not on its history comment', () => {
    // Pay the engine.ts debt but keep the comment naming the old pattern: the
    // ratchet must still fire, or the entry lingers as dead config forever.
    const { staleKnown, staleMentions } = repoWith({
      [MENTION.file]: `${MENTION.text}\n`,
      [ENGINE_MENTION.file]: `${ENGINE_MENTION.text}\nexport const done = escapeCsvCell;\n`,
    }, MENTIONS);
    assert.deepEqual(staleKnown, KNOWN_REMAINING, 'comment-only liveness must not keep the debt entry alive');
    assert.deepEqual(staleMentions, []);
  });

  describe('validateMentions rejects entries that could excuse executable text', () => {
    const P = '`/^[=+\\-@\\t\\r]/`';
    const bad = [
      ['untrimmed text', { file: 'a/b.ts', text: `  // pad ${P}` }, /trimmed/],
      ['not a line comment', { file: 'a/b.ts', text: `* docblock body ${P}` }, /line comment/],
      ['template interpolation', { file: 'a/b.ts', text: `// \${run()} ${P}` }, /execute/],
      ['block terminator', { file: 'a/b.ts', text: `// ${P} *` + `/ tail()` }, /block comment/],
      ['matches no pattern', { file: 'a/b.ts', text: '// plain prose' }, /no PATTERN/],
      ['already-exempt file', { file: CANONICAL[0], text: `// ${P}` }, /exempt/],
    ];
    for (const [name, entry, re] of bad) {
      it(name, () => assert.throws(() => validateMentions([entry]), re));
    }
    it('accepts the real registry', () => validateMentions());
  });

  it('a registered line is inert even as regex source — executed, not asserted', () => {
    // The one way registered text could "run" is as data fed to a regex
    // compiler. Build that regex and show it cannot function as a trigger
    // guard: the prose prefix means no bare trigger cell matches.
    for (const m of PROSE_MENTIONS) {
      let re = null;
      try {
        re = new RegExp(m.text);
      } catch {
        // not even a valid regex: inert
      }
      if (re) {
        for (const cell of ['=cmd()', '+1', '-2', '@x', '\tt', '\rr', '=HYPERLINK("http://x")']) {
          assert.equal(re.test(cell), false, `registered text works as a trigger guard on ${JSON.stringify(cell)}`);
        }
      }
    }
  });
});
