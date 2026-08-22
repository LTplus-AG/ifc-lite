#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fails the build if a CSV cell escaper is hand-rolled anywhere outside the two
 * canonical implementations.
 *
 * This repo reached NINE copies of the spreadsheet formula-injection guard
 * (CWE-1236) and no two were identical: some tested the trigger anchored at
 * offset 0 (bypassable with a BOM/ZWSP/LRM/NBSP/U+2028), some hardened it by
 * DELETING the leading invisibles (which threw away leading spaces, against
 * RFC 4180 §2.4), one hard-coded a comma while its caller had a configurable
 * delimiter. Correcting nine copies only resets the clock — they drift again.
 * This gate is what stops a tenth appearing.
 *
 * Two patterns are looked for, because they are what every copy had in common:
 *
 *   1. the formula-trigger character class `[=+\-@\t\r]` / `'=' | '+' | ...`
 *   2. RFC 4180 quote-doubling — replacing `"` with `""`
 *
 * Run: `node scripts/check-csv-escaper-copies.mjs`
 * Self-test: `node --test scripts/check-csv-escaper-copies.test.mjs`
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ONE implementation per language. Anything else matching a pattern below
 * is a copy. Deliberately NOT an open-ended allowlist: adding a path here is
 * adding a tenth escaper, which is the thing being prevented — the fix is to
 * call the shared escaper instead.
 */
export const CANONICAL = [
  'packages/export/src/csv-cell.ts',
  'rust/export/src/csv_cell.rs',
];

/**
 * Files that legitimately name the patterns without implementing an escaper:
 * the shared fixture, the parity suites, the generator, and this gate plus its
 * own test. Each is here because it *tests or documents* the canonical guard.
 */
export const NON_IMPLEMENTATION = [
  'rust/export/tests/fixtures/csv_cell_vectors.json',
  'rust/export/tests/csv_cell_parity.rs',
  'packages/export/src/csv-cell.parity.test.ts',
  'scripts/gen-csv-cell-vectors.mjs',
  'scripts/check-csv-escaper-copies.mjs',
  'scripts/check-csv-escaper-copies.test.mjs',
];

/**
 * Copies that still exist and are NOT yet routed through the canonical escaper.
 *
 * A ratchet, not an allowance. Two rules keep it from rotting into one:
 *
 *  * a NEW copy anywhere fails the gate — this list cannot absorb it, because
 *    entries are matched by exact path;
 *  * an entry that no longer matches any pattern ALSO fails the gate, so the
 *    list shrinks when the debt is paid instead of lingering as dead config.
 *
 * `packages/lists/src/engine.ts` — the library's Lists CSV writer. Left here
 * for two reasons, both structural rather than discretionary:
 *   1. `@ifc-lite/lists` does not depend on `@ifc-lite/export`, so it cannot
 *      call the shared escaper without a new package dependency — a maintainer
 *      call, not a mechanical rewire.
 *   2. It carries the #1772 numeric exemption (`-0.35` stays summable), which
 *      the viewer's Lists export deliberately does NOT. That policy split is
 *      unresolved and is a product decision. The shared escaper can express
 *      both (`exemptNumbers`), so adopting it needs no behaviour change — only
 *      the dependency and someone's say-so.
 */
export const KNOWN_REMAINING = ['packages/lists/src/engine.ts'];

export const PATTERNS = [
  {
    name: 'formula-trigger character class',
    // The TS spelling: a character class holding =, +, -, @ together.
    re: /\[=\+\\?-@/,
    hint: 'call escapeCsvCell()/guardSpreadsheetFormula() from @ifc-lite/export, or escape_csv_cell() from ifc_lite_export::csv_cell',
  },
  {
    name: 'formula-trigger match arm',
    // The Rust spelling: a char pattern listing the same triggers.
    re: /'='\s*\|\s*'\+'/,
    hint: 'call ifc_lite_export::csv_cell::escape_csv_cell',
  },
  {
    name: 'RFC 4180 quote doubling',
    // TS `.replace(/"/g, '""')` and Rust `.replace('"', "\"\"")`.
    re: /replace\(\s*(?:\/"\/g\s*,\s*'""'|'"'\s*,\s*"\\"\\""\s*)\)/,
    hint: 'quoting belongs in the shared escaper, not at the call site',
  },
];

/** Repository-tracked files worth scanning. */
function candidateFiles() {
  const out = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', '-z', '*.ts', '*.tsx', '*.rs', '*.mjs', '*.js'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter(Boolean);
}

/**
 * Blank out comment CONTENT, leaving code and line structure intact.
 *
 * Four leading-character heuristics were tried before this and each shipped a
 * hole, every time in the same direction -- a real escaper made invisible:
 *
 *   skip `//`, `*`, `/*`   missed Rust `*out = matches!(..)` and `/* c *""/ code`
 *   skip `//` only         missed `/* \n // *""/ code`, where `*""/` resumes the line
 *   track block state      missed code after `const s = "/* x";`
 *   plus a star-space rule missed `* quote(cells) {}`, a live JS generator method
 *
 * All four passed the same 17 tests. A leading character cannot decide whether
 * a line is a comment, because that depends on what precedes it on the SAME
 * line and on the lines above. So this walks the text once, tracking the only
 * states that change what a character means: line comment, block comment, the
 * three string flavours, and regex literals.
 *
 * Comment characters become spaces rather than being deleted, so line numbers
 * and columns survive and a pattern can still match code sharing a line with a
 * trailing comment.
 *
 * THE SAFETY PROPERTY, stated because the four attempts above each rested on an
 * unstated one that turned out false: **only comment content is blanked.**
 * Strings and regexes are skipped over, never written to. So every way this can
 * be wrong about where a string ends -- a Rust char literal `'='`, a lifetime
 * `&'a str`, an unterminated quote, a backtick inside a single-quoted string --
 * costs at most a MISSED comment, which is a false red. None of them can hide a
 * line of code, because hiding requires writing spaces and that happens only
 * inside a proven block-comment or line-comment run.
 *
 * (Deliberately NOT spelling the block terminator here: writing it inside this
 * docblock closes the docblock, which is how this very edit first broke the
 * file -- the same hazard as the backtick that closed the codegen template.)
 *
 * Verified rather than asserted: `matches!(c, '=' | '+' | '-' | '@')` is still
 * caught after a lifetime declaration and after an unterminated `'`.
 *
 * Rust block comments nest and this does not track depth, so a nested comment
 * closes early and its tail is scanned as code. Same direction: scanning MORE
 * is a false red someone investigates rather than a bypass nobody sees.
 */
const REGEX_KEYWORD = /^(return|typeof|instanceof|in|of|case|yield|await|delete|void|new|do|else)$/;

export function blankComments(text) {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  // Regex-vs-division turns on the previous significant character: `/` after a
  // value is division, after an operator or opener it starts a regex.
  let prevSig = '';
  let prevWord = '';
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (c === '/' && d === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      prevSig = 'x';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      // RESYNC AT THE NEWLINE for ' and ". Neither can span a line in JS, TS or
      // ordinary Rust, and without the bound one unpaired quote in CODE opens a
      // fake string that runs to the next quote ANYWHERE in the file, losing
      // phase for everything after it. That is not hypothetical: a Rust
      // lifetime `&'a str` has an odd number of quotes, and so does a JSX
      // contraction like `What's New`. 170 .rs files and any .tsx with a
      // contraction were affected, leaving real comments unblanked (a false
      // red) and, once phase inverts, letting a `//` inside a real string blank
      // live code (a bypass).
      //
      // Backticks DO span lines, so they are not bounded. An unterminated one
      // still costs at most a missed comment, never a hidden line of code.
      const bounded = c !== '`';
      i += 1;
      while (i < n) {
        if (bounded && text[i] === '\n') break;
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === c) { i += 1; break; }
        i += 1;
      }
      prevSig = 'x';
      continue;
    }
    // A `/` opens a regex after an operator or opener, and also after a keyword
    // -- `return /["]/.test(s)` is a regex, not division. Without the keyword
    // arm the quote inside it was read as a string opener and shifted phase.
    if (c === '/' && (/[=(,:;[{!&|?+\-*%~^<>]/.test(prevSig) || REGEX_KEYWORD.test(prevWord))) {
      i += 1;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') { while (i < n && text[i] !== ']' && text[i] !== '\n') i += 1; }
        if (text[i] === '/') { i += 1; break; }
        i += 1;
      }
      prevSig = 'x';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let k = i;
      while (k < n && /[A-Za-z0-9_$]/.test(text[k])) k += 1;
      prevWord = text.slice(i, k);
      prevSig = text[k - 1];
      i = k;
      continue;
    }
    if (!/\s/.test(c)) { prevSig = c; prevWord = ''; }
    i += 1;
  }
  return out.join('');
}

/** Scan one file's text; returns the violations found in it. */
export function scanText(relPath, text) {
  const normalized = relPath.split(sep).join('/');
  if (CANONICAL.includes(normalized) || NON_IMPLEMENTATION.includes(normalized)) return [];
  const found = [];
  const rawLines = text.split('\n');
  // Comment CONTENT is blanked, code is not. A pattern can therefore still
  // match code that shares a line with a comment, while prose describing the
  // pattern -- which is what every fix for this defect writes -- cannot red it.
  const lines = blankComments(text).split('\n');
  for (const p of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (p.re.test(lines[i])) {
        found.push({ file: normalized, line: i + 1, pattern: p.name, hint: p.hint, text: rawLines[i].trim() });
      }
    }
  }
  return found;
}

export function scanRepo(files = candidateFiles(), read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8')) {
  // A tiny file list means the glob or `git ls-files` silently failed, which
  // would make this gate pass vacuously — the one way a grep gate lies.
  if (files.length < 100) {
    throw new Error(
      `refusing to pass on a suspiciously small file list (${files.length}); the scan is broken, not clean`,
    );
  }
  const hits = [];
  for (const f of files) {
    let text;
    try {
      text = read(f);
    } catch {
      continue; // deleted or unreadable in this checkout
    }
    hits.push(...scanText(f, text));
  }
  const known = new Set(KNOWN_REMAINING);
  const violations = hits.filter((h) => !known.has(h.file));
  const stillHit = new Set(hits.filter((h) => known.has(h.file)).map((h) => h.file));
  const staleKnown = KNOWN_REMAINING.filter((k) => !stillHit.has(k));
  return { scanned: files.length, violations, staleKnown, known: [...stillHit] };
}

function main() {
  const { scanned, violations, staleKnown, known } = scanRepo();
  let failed = false;

  if (violations.length > 0) {
    failed = true;
    process.stderr.write(
      `A hand-rolled CSV cell escaper appeared in ${violations.length} place(s).\n` +
        'There must be exactly one per language:\n' +
        CANONICAL.map((c) => `  - ${c}\n`).join('') +
        '\n',
    );
    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${v.line}  [${v.pattern}]\n      ${v.text}\n      → ${v.hint}\n`);
    }
  }

  if (staleKnown.length > 0) {
    failed = true;
    process.stderr.write(
      'KNOWN_REMAINING is stale — these no longer hand-roll an escaper, so delete them\n' +
        'from the list (it is a ratchet; it must shrink, never linger):\n' +
        staleKnown.map((k) => `  - ${k}\n`).join(''),
    );
  }

  if (failed) process.exit(1);

  process.stdout.write(
    `check:csv-escapers — ${scanned} files scanned, no new copies` +
      (known.length > 0 ? `; ${known.length} known outstanding: ${known.join(', ')}` : '') +
      '.\n',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
