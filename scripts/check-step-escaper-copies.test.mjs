/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gate's own test. A pattern gate that does not fire is worse than no
 * gate, because it reads as a guarantee — so each positive case below plants
 * a synthetic escaper shaped like a real full implementation of the STEP
 * escaper's four rules and asserts the gate catches it, paired with a
 * negative control that is missing one of the three required signals (this
 * repo has no known real historical THIRD copy the way the CSV gate had nine
 * real ones, so these fixtures are synthetic, matching PATTERNS by
 * construction).
 *
 * Run: `node --test scripts/check-step-escaper-copies.test.mjs`
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as gate from './check-step-escaper-copies.mjs';

const { scanText, scanRepo, CANONICAL, KNOWN_REMAINING } = gate;

/**
 * Drive scanRepo with synthetic file contents. Real repo files not named in
 * `overrides` read as empty; padding files satisfy the vacuous-scan guard.
 */
function repoWith(overrides) {
  const pad = Array.from({ length: 120 }, (_, i) => `packages/pad/src/p${i}.ts`);
  const files = [...new Set([...Object.keys(overrides), ...pad])];
  return scanRepo(files, (f) => overrides[f] ?? '');
}

const TS_FULL_COPY = `
function escapeStep(str) {
  return str
    .replace(/\\\\/g, '\\\\\\\\')
    .replace(/'/g, "''")
    .replace(/[\\x00-\\x1F\\x7F]/g, ' ')
    .split('')
    .map((ch) => (ch.codePointAt(0) > 126 ? \`\\\\X2\\\\\${ch.codePointAt(0).toString(16)}\\\\X0\\\\\` : ch))
    .join('');
}
`;

const RUST_FULL_COPY = `
fn escape_step(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '\\'' => out.push_str("''"),
            '\\\\' => out.push_str("\\\\\\\\"),
            '\\0'..='\\u{1F}' => out.push(' '),
            _ => out.push_str(&format!("\\\\X2\\\\{:04X}\\\\X0\\\\", c as u32)),
        }
    }
    out
}
`;

test('fires on a full TypeScript copy of the escaper', () => {
  const hits = scanText('packages/some/new-step-writer.ts', TS_FULL_COPY);
  assert.ok(hits.length > 0, 'gate missed a full TS copy');
  assert.equal(hits[0].file, 'packages/some/new-step-writer.ts');
  assert.deepEqual(hits[0].patterns, [
    'backslash-doubling',
    'apostrophe-doubling',
    '\\X2\\ / \\X0\\ directive emission',
  ]);
});

test('fires on a full Rust copy of the escaper', () => {
  const hits = scanText('rust/newcrate/src/step_write.rs', RUST_FULL_COPY);
  assert.ok(hits.length > 0, 'gate missed a full Rust copy');
  assert.equal(hits[0].file, 'rust/newcrate/src/step_write.rs');
});

test('the canonical implementations are exempt at repo level', () => {
  const { violations } = repoWith({
    [CANONICAL[0]]: TS_FULL_COPY,
    [CANONICAL[1]]: RUST_FULL_COPY,
  });
  assert.deepEqual(violations, [], 'the canonical files ARE the escaper and must be allowed to contain it');
});

test('refuses to pass vacuously when the file scan returns almost nothing', () => {
  assert.throws(
    () => scanRepo(['a.ts'], () => ''),
    /suspiciously small file list/,
    'a broken scan must fail, not report clean',
  );
});

test('the repo currently has no NEW copies, and every ratchet entry is still real', () => {
  const { violations, staleKnown, scanned } = scanRepo();
  assert.ok(scanned > 1000, `expected a real scan, got ${scanned} files`);
  assert.deepEqual(violations, [], 'a new hand-rolled STEP escaper was added');
  assert.deepEqual(
    staleKnown,
    [],
    'KNOWN_REMAINING is a ratchet: an entry that no longer hand-rolls an escaper must be deleted from the list',
  );
});

test('KNOWN_REMAINING starts empty: no known third full copy at the time this gate was written', () => {
  assert.deepEqual(KNOWN_REMAINING, []);
});

// ---------------------------------------------------------------------------
// Negative controls: real files in this repo that touch ONE OR TWO of the
// three signals but not all three, and must not be flagged. Pinned by literal
// snippet (not by reading the live file) so this test does not depend on
// those files' current exact text, only on the SHAPE that must stay clean.
// ---------------------------------------------------------------------------
describe('does not fire on a partial match (missing one of the three signals)', () => {
  test('backslash+apostrophe doubling with no directive emission (mutate.ts / schedule-serializer.ts / ifc-creator-math.ts shape)', () => {
    const src = `
function esc(str) {
  return str.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "''");
}
`;
    const hits = scanText('packages/some/narrow-quoter.ts', src);
    assert.deepEqual(hits, [], 'a probe with only 2 of 3 signals must not fire the full-copy gate');
  });

  test('directive emission with no doubling (encodeIfcString / a decoder shape)', () => {
    const src = `
function encode(str) {
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp > 126) out += \`\\\\X2\\\\\${cp.toString(16)}\\\\X0\\\\\`;
    else out += ch;
  }
  return out;
}
`;
    const hits = scanText('packages/some/narrow-encoder.ts', src);
    assert.deepEqual(hits, [], 'directive emission alone (no doubling) must not fire the full-copy gate');
  });

  test('a decoder that only reads \\\\X2\\\\ / \\\\X0\\\\ never fires, even with unrelated doubling elsewhere in the file', () => {
    const src = `
// scans for the X2 directive and decodes it back to a code point
function decode(str) {
  if (str.startsWith('\\\\X2\\\\')) { /* ... */ }
  return str.replace(/''/g, "'"); // unrelated: un-doubling on the READ side
}
`;
    const hits = scanText('packages/some/decoder.ts', src);
    assert.deepEqual(hits, [], 'a decoder plus unrelated un-doubling must not fire the full-copy gate');
  });

  test('apostrophe-doubling alone (an unrelated SQL/CSV-shaped quoter) does not fire', () => {
    const src = `function q(v) { return "'" + v.replace(/'/g, "''") + "'"; }`;
    const hits = scanText('packages/some/sql-quote.ts', src);
    assert.deepEqual(hits, [], 'apostrophe doubling alone is common to many quoters, not just this escaper');
  });
});

describe('co-occurrence is per-FILE, not per-line', () => {
  test('the three signals spread across separate lines/functions in one file still fire', () => {
    const src = `
function doubleBackslash(s) { return s.replace(/\\\\/g, '\\\\\\\\'); }
function doubleQuote(s) { return s.replace(/'/g, "''"); }
function directive(cp) { return \`\\\\X2\\\\\${cp}\\\\X0\\\\\`; }
`;
    const hits = scanText('packages/some/split-copy.ts', src);
    assert.ok(hits.length > 0, 'a copy split across helpers in one file is still a copy');
  });

  test('the three signals in DIFFERENT files do not co-fire as one violation', () => {
    const { violations } = repoWith({
      'packages/some/a.ts': `s.replace(/\\\\/g, '\\\\\\\\');`,
      'packages/some/b.ts': `s.replace(/'/g, "''");`,
      'packages/some/c.ts': `\`\\\\X2\\\\\${cp}\\\\X0\\\\\`;`,
    });
    assert.deepEqual(violations, [], 'the three signals in three unrelated files are not one copy');
  });
});
