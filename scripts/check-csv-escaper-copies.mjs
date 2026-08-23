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

/** Scan one file's text; returns the violations found in it. */
export function scanText(relPath, text) {
  const normalized = relPath.split(sep).join('/');
  if (CANONICAL.includes(normalized) || NON_IMPLEMENTATION.includes(normalized)) return [];
  const found = [];
  for (const p of PATTERNS) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (p.re.test(lines[i])) {
        found.push({ file: normalized, line: i + 1, pattern: p.name, hint: p.hint, text: lines[i].trim() });
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
