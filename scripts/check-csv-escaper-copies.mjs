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
 * Three patterns are looked for, because they are what every copy had in common:
 *
 *   1. the formula-trigger character class `[=+\-@\t\r]` (TS/JS)
 *   2. the same triggers as a Rust match arm, `'=' | '+' | ...`
 *   3. RFC 4180 quote-doubling — replacing `"` with `""`
 *
 * DESIGN: the scan is a raw, per-line, stateless grep. Comments and strings are
 * scanned exactly like code — nothing is blanked, skipped, or tokenised. Six
 * attempts at comment-awareness (leading-character skips, block-state tracking,
 * a string- and regex-aware tokeniser) each shipped a hole, and every hole was
 * the same shape: a live, working escaper made invisible. A classifier that
 * decides "this text is a comment" can be wrong in only one useful direction,
 * and it was wrong in the other one six times. Statelessness is the structural
 * fix: no line's classification depends on any other line, so no context —
 * string, template, lifetime, nested comment — can hide a match.
 *
 * The cost is that prose NAMING a pattern (a comment quoting the trigger regex)
 * matches too. That is handled by PROSE_MENTIONS below: an exact-line registry
 * with the same ratchet semantics as KNOWN_REMAINING. In this repo's whole
 * history exactly two such lines exist, so the registry is two entries, and a
 * new doc comment that quotes a pattern costs its author one visible, guided,
 * one-line registration — a false red someone resolves in a minute, never a
 * false green nobody sees.
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
 *  * an entry whose CODE no longer matches any pattern ALSO fails the gate, so
 *    the list shrinks when the debt is paid instead of lingering as dead
 *    config. Prose mentions inside the file do not keep an entry alive — see
 *    PROSE_MENTIONS — so deleting the copy while keeping its history comment
 *    still trips the ratchet.
 *
 * `packages/lists/src/engine.ts` — the library's Lists CSV writer. Left here
 * for two reasons, both structural rather than discretionary:
 *   1. `@ifc-lite/lists` does not depend on `@ifc-lite/export`. There is no
 *      CYCLE stopping it — `export` never reaches `lists` — but `export` drags
 *      in parquet-wasm, apache-arrow and jszip, which is a lot to add to a
 *      package whose only deps are `data` and `encoding`. The way out is to
 *      move the escaper DOWN into `@ifc-lite/encoding` (zero deps, already a
 *      dependency of both) and re-export it, the way `isWhollyNumeric` already
 *      went. That is a maintainer call, not a mechanical rewire.
 *   2. It carries the #1772 numeric exemption (`-0.35` stays summable). That
 *      used to be a policy split, because every other writer guarded numbers;
 *      it is no longer one — the shared escaper exempts them BY DEFAULT, so
 *      adopting it here is now behaviour-preserving and the only thing left in
 *      the way is the package dependency.
 */
export const KNOWN_REMAINING = ['packages/lists/src/engine.ts'];

export const PATTERNS = [
  {
    name: 'formula-trigger character class',
    // The TS spelling: a character class holding =, +, -, @ together. Any
    // number of backslashes before the `-`, because the same class written as
    // a STRING for `new RegExp("^[=+\\-@\\t\\r]")` doubles them — a working
    // escaper the single-backslash spelling missed.
    re: /\[=\+\\*-@/,
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

/**
 * Individual comment lines that quote a pattern while documenting it. Each
 * entry excuses a hit only when BOTH match exactly: the file path AND the full
 * trimmed line text. Ratcheted like KNOWN_REMAINING: an entry that no longer
 * matches a hit fails the gate and must be deleted.
 *
 * Why exact lines instead of comment detection: deciding "is this text a
 * comment" requires tracking string, template, regex, and comment state across
 * the whole file in three languages, and six attempts at that each hid a live
 * escaper. Exact-line registration cannot hide one, by construction:
 *
 *  * excusal requires the WHOLE trimmed line to equal a registered sentence,
 *    so any code sharing the line changes the text and the hit stands;
 *  * `validateMentions()` (run at import) requires each entry to start with
 *    `//` and to contain neither `${` nor the star-slash block terminator
 *    (not spelled here: writing it would close this docblock). Under every
 *    grammar this repo scans, a line satisfying that is either a comment or
 *    inert string/JSX data — it cannot EXECUTE. `${` is excluded because
 *    template interpolation is the one way a `//`-leading line can run code;
 *    the terminator because it could hand the line's tail back to the
 *    compiler. Feeding the registered text to `new RegExp` yields a pattern
 *    prefixed with the English prose, which cannot match a bare trigger cell
 *    — demonstrated by execution in the self-test.
 *
 * The registry does NOT generalise to unregistered prose: a new comment that
 * quotes a pattern reds the gate until its author registers the line here.
 * That is the chosen trade. The unwritten tenth copy is code someone writes on
 * purpose, in whatever shape they find natural (the canonical implementation
 * itself defines its regex on a standalone line, so no adjacency or context
 * rule survives contact with real style); prose collisions are accidents, rare
 * (two lines in 4255 files across the repo's history), and each costs one
 * visible, self-explanatory line here. A false red is a minute of a
 * documenter's time; a false green is the tenth copy shipping.
 */
export const PROSE_MENTIONS = [
  {
    file: 'packages/lists/src/engine.ts',
    text: '// anchored `/^[=+\\-@\\t\\r]/` matching, so `\\uFEFF=HYPERLINK(...)` used to',
  },
];

/**
 * Refuse registry entries that could excuse executable text. Throws on the
 * first invalid entry; runs against the real registry at import time so the
 * gate cannot even load with an unsafe entry.
 */
export function validateMentions(mentions = PROSE_MENTIONS) {
  for (const m of mentions) {
    const id = `PROSE_MENTIONS entry for ${m.file}`;
    if (typeof m.file !== 'string' || typeof m.text !== 'string') {
      throw new Error(`${id}: needs string \`file\` and \`text\``);
    }
    if (m.text !== m.text.trim()) {
      throw new Error(`${id}: text must be trimmed (hits are compared trimmed)`);
    }
    if (!m.text.startsWith('//')) {
      throw new Error(`${id}: must be a \`//\` line comment; block-comment bodies carry no marker of their own and cannot be excused safely`);
    }
    if (m.text.includes('${')) {
      throw new Error(`${id}: \`\${\` would execute inside a template literal, so the line would not be inert`);
    }
    if (m.text.includes('*/')) {
      throw new Error(`${id}: \`*/\` could close an open block comment and hand the tail back to the compiler`);
    }
    if (!PATTERNS.some((p) => p.re.test(m.text))) {
      throw new Error(`${id}: matches no PATTERN, so it can never excuse a hit — delete it`);
    }
    if (CANONICAL.includes(m.file) || NON_IMPLEMENTATION.includes(m.file)) {
      throw new Error(`${id}: that file is already exempt wholesale`);
    }
  }
}
validateMentions();

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
 * Scan one file's text; returns every pattern hit in it, comments included.
 *
 * Deliberately stateless and raw: each line is tested against each pattern
 * with no transformation, so nothing that happens on one line — an unclosed
 * string, a block comment, a template literal — can hide a match on another.
 * Whether a hit is EXCUSED (canonical file, known copy, registered prose
 * mention) is policy, and all of it lives in scanRepo.
 */
export function scanText(relPath, text) {
  const normalized = relPath.split(sep).join('/');
  const found = [];
  const rawLines = text.split('\n');
  for (const p of PATTERNS) {
    for (let i = 0; i < rawLines.length; i++) {
      if (p.re.test(rawLines[i])) {
        found.push({ file: normalized, line: i + 1, pattern: p.name, hint: p.hint, text: rawLines[i].trim() });
      }
    }
  }
  return found;
}

export function scanRepo(
  files = candidateFiles(),
  read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8'),
  // Injectable so the behavioural tests build their own fixtures instead of
  // binding to whatever the live registry happens to hold. A registry entry is
  // deleted the moment its line is reworded, so tests keyed to it break for a
  // reason that has nothing to do with the behaviour they cover.
  mentions = PROSE_MENTIONS,
) {
  // A tiny file list means the glob or `git ls-files` silently failed, which
  // would make this gate pass vacuously — the one way a grep gate lies.
  if (files.length < 100) {
    throw new Error(
      `refusing to pass on a suspiciously small file list (${files.length}); the scan is broken, not clean`,
    );
  }
  const exempt = new Set([...CANONICAL, ...NON_IMPLEMENTATION]);
  const hits = [];
  for (const f of files) {
    if (exempt.has(f.split(sep).join('/'))) continue;
    let text;
    try {
      text = read(f);
    } catch {
      continue; // deleted or unreadable in this checkout
    }
    hits.push(...scanText(f, text));
  }

  // Excuse registered prose mentions: exact file AND exact trimmed line.
  const usedMentions = new Set();
  const remaining = hits.filter((h) => {
    const idx = mentions.findIndex((m) => m.file === h.file && m.text === h.text);
    if (idx === -1) return true;
    usedMentions.add(idx);
    return false;
  });
  const staleMentions = mentions.filter((_, i) => !usedMentions.has(i));

  const known = new Set(KNOWN_REMAINING);
  const violations = remaining.filter((h) => !known.has(h.file));
  // KNOWN_REMAINING liveness counts only non-prose hits, so paying the debt
  // trips the ratchet even if a history comment naming the pattern stays.
  const stillHit = new Set(remaining.filter((h) => known.has(h.file)).map((h) => h.file));
  const staleKnown = KNOWN_REMAINING.filter((k) => !stillHit.has(k));
  return { scanned: files.length, violations, staleKnown, staleMentions, known: [...stillHit] };
}

function main() {
  const { scanned, violations, staleKnown, staleMentions, known } = scanRepo();
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
    process.stderr.write(
      '\nIf a flagged line is a COMMENT that documents the pattern rather than code,\n' +
        'register its exact text in PROSE_MENTIONS in scripts/check-csv-escaper-copies.mjs.\n',
    );
  }

  if (staleKnown.length > 0) {
    failed = true;
    process.stderr.write(
      'KNOWN_REMAINING is stale — these no longer hand-roll an escaper, so delete them\n' +
        'from the list (it is a ratchet; it must shrink, never linger):\n' +
        staleKnown.map((k) => `  - ${k}\n`).join(''),
    );
  }

  if (staleMentions.length > 0) {
    failed = true;
    process.stderr.write(
      'PROSE_MENTIONS is stale — these registered comment lines no longer exist, so\n' +
        'delete them (it is a ratchet; it must shrink, never linger):\n' +
        staleMentions.map((m) => `  - ${m.file}: ${m.text}\n`).join(''),
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
