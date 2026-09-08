#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fails the build if a STEP (ISO 10303-21) string-literal ENCODE escaper is
 * hand-rolled anywhere outside the two canonical implementations.
 *
 * Issue #3300 (second half): this repo already had two TypeScript copies of
 * the encode-side escaper (`escapeStepString`), collapsed into one in the
 * first half of #3300 (#3378). Even after that collapse, the TWO REMAINING
 * implementations — TypeScript `escapeStepString` and Rust `step_text::escape`
 * — genuinely cannot share code (no wasm adapter between them), and each was
 * pinned against the OTHER's behaviour only via its own hand-written literal
 * test table, with a comment claiming the two agreed. That is exactly the
 * arrangement #3300 identifies as the cause of #3284 (a control-character run
 * collapsed to one space on one side and one space PER CHARACTER on the
 * other, and every test on both sides stayed green because neither used a
 * run). The two hand tables are now one shared vector fixture
 * (`rust/export/tests/fixtures/step_escape_vectors.json`); this gate is what
 * stops a THIRD full re-implementation of the escaper — TypeScript or Rust —
 * from appearing next to the two canonical ones, the same way
 * `check-csv-escaper-copies.mjs` guards the CSV-cell escaper. Unlike that
 * gate, this repo has no known history of nine STEP-escaper copies: a search
 * at the time this gate was written found no OTHER full implementation of
 * this escaper's four rules (backslash doubling, apostrophe doubling,
 * control-char-to-space, non-ASCII \X2\/\X4\ directive encoding) together in
 * one place, so `KNOWN_REMAINING` starts empty. It is a ratchet, not a
 * guarantee that stays true — it exists so a new one can only enter this file
 * as a visible, reviewed exception, never as silent debt.
 *
 * Four rules make up the escaper; two files legitimately touch a SUBSET of
 * them without being a copy:
 *   - `packages/encoding/src/ifc-string.ts`'s `encodeIfcString` emits the same
 *     `\X2\`/`\X4\` directive shape, but for a DIFFERENT byte range (it also
 *     encodes 8-bit values as `\X\HH`, which this escaper never emits) and
 *     WITHOUT apostrophe/backslash doubling or control-to-space mapping — a
 *     bare backslash there becomes `\X\5C`, not `\\`. It is a different,
 *     narrower escaper (#3300's own text says so), not a copy of this one.
 *   - `packages/cli/src/commands/mutate.ts`, `packages/parser/src/schedule-serializer.ts`,
 *     and `packages/create/src/ifc-creator-math.ts` each carry
 *     `.replace(/\\/g, '\\\\').replace(/'/g, "''")` — backslash and apostrophe
 *     doubling, the STEP quoting rule these three actually need for their own
 *     narrow inputs (short, caller-controlled identifiers/paths). None of the
 *     three maps a control character to a space or emits a `\X2\`/`\X4\`
 *     directive for non-ASCII text, so none of them implements the FULL
 *     four-rule escaper this gate exists to keep singular. They are two-ninths
 *     of the shape, not the shape, and PATTERNS is deliberately built to need
 *     all three signals below so it does not flag them.
 *
 * Three signals, ALL required in the SAME file, distinguish a full copy of
 * this escaper from the many STEP directive DECODERS/PARSERS in this repo
 * (which read `\X2\`/`\X4\` but never emit apostrophe+backslash doubling in
 * the same function) and from the two narrower escapers above:
 *
 *   1. backslash-doubling (TS `replace(/\\/g, ...)` / Rust `'\\' => ... "\\\\"`)
 *   2. apostrophe-doubling (TS `replace(/'/g, "''")` / Rust `'\'' => ... "''"`)
 *   3. the `\X2\`/`\X0\` directive-emission shape (both markers, so a decoder
 *      merely scanning for `\X2\` alone does not count)
 *
 * DESIGN: the scan is a raw, per-file, stateless text search — no comment or
 * string blanking, following `check-csv-escaper-copies.mjs`'s precedent for
 * the same reason: a classifier that decides "this text is a comment" can
 * hide a live copy, and cannot hide a false positive in the other direction.
 * Unlike the CSV gate (which scans per LINE, because its three single-line
 * patterns are each individually distinctive), this gate's distinguishing
 * signal is CO-OCCURRENCE of three patterns that a real implementation writes
 * on separate lines (see `step_text.rs` and `step-serializers.ts` themselves),
 * so it searches per FILE: all three regexes must match somewhere in the same
 * file's text for a hit.
 *
 * Run: `node scripts/check-step-escaper-copies.mjs`
 * Self-test: `node --test scripts/check-step-escaper-copies.test.mjs`
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ONE implementation per language. Anything else matching all three
 * PATTERNS is a copy. Deliberately NOT an open-ended allowlist: adding a path
 * here is adding a third full escaper, which is the thing being prevented —
 * the fix is to call the shared escaper instead.
 */
export const CANONICAL = ['packages/data/src/step-serializers.ts', 'rust/export/src/step_text.rs'];

/**
 * Files that legitimately mention all three patterns without implementing a
 * NEW copy: the shared fixture, the parity suites, this gate plus its own
 * test.
 */
export const NON_IMPLEMENTATION = [
  'rust/export/tests/fixtures/step_escape_vectors.json',
  'rust/export/tests/step_escape_parity.rs',
  'packages/data/src/step-escape.parity.test.ts',
  'scripts/check-step-escaper-copies.mjs',
  'scripts/check-step-escaper-copies.test.mjs',
];

/**
 * Copies that still exist and are NOT yet routed through the canonical
 * escaper. A ratchet, like `check-csv-escaper-copies.mjs`'s: a NEW copy
 * anywhere fails the gate (entries are matched by exact path, so this list
 * cannot silently absorb one), and an entry whose code no longer matches all
 * three PATTERNS ALSO fails the gate, so the list shrinks when debt is paid
 * rather than lingering as dead config.
 *
 * Starts empty: the grep this gate's header describes found no OTHER file
 * implementing all four of the escaper's rules together (see the three
 * two-of-four files discussed above, which PATTERNS is built not to flag).
 */
export const KNOWN_REMAINING = [];

export const PATTERNS = [
  {
    name: 'backslash-doubling',
    // TS: `.replace(/\\/g, '\\\\')` (any escaping of the literal backslash
    // inside the regex/replacement is fine — this matches the shape, not one
    // exact spelling). Rust: a `'\\' => ...` match arm producing two
    // backslashes.
    re: /replace\(\s*\/\\\\\/g\s*,\s*'\\\\\\\\'\s*\)|'\\\\'\s*=>\s*[^\n]*"\\\\\\\\"/,
    hint: 'call escapeStepString() from @ifc-lite/data, or ifc_lite_export::escape_step_string()',
  },
  {
    name: 'apostrophe-doubling',
    // TS: `.replace(/'/g, "''")`. Rust: `'\'' => out.push_str("''")` or
    // equivalent producing a doubled apostrophe.
    re: /replace\(\s*\/'\/g\s*,\s*"''"\s*\)|'\\''\s*=>\s*[^\n]*"''"/,
    hint: 'call escapeStepString() from @ifc-lite/data, or ifc_lite_export::escape_step_string()',
  },
  {
    name: '\\X2\\ / \\X0\\ directive emission',
    // Both markers of the directive wrapper must appear (as literal text a
    // template/format string would emit), not just a lone `\X2\` a decoder
    // might scan for.
    re: /\\\\X2\\\\[\s\S]*?\\\\X0\\\\/,
    hint: 'call escapeStepString() from @ifc-lite/data, or ifc_lite_export::escape_step_string()',
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
 * Scan one file's whole text: a hit requires ALL THREE patterns to match
 * somewhere in the file (co-occurrence, not per-line — a real implementation
 * spreads the three rules across separate lines/match-arms).
 */
export function scanText(relPath, text) {
  const normalized = relPath.split(sep).join('/');
  const hitsPerPattern = PATTERNS.map((p) => p.re.test(text));
  if (!hitsPerPattern.every(Boolean)) return [];
  return [
    {
      file: normalized,
      patterns: PATTERNS.map((p) => p.name),
      hint: PATTERNS[0].hint,
    },
  ];
}

export function scanRepo(
  files = candidateFiles(),
  read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8'),
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
    const normalized = f.split(sep).join('/');
    if (exempt.has(normalized)) continue;
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
      `A hand-rolled STEP string escaper appeared in ${violations.length} place(s).\n` +
        'There must be exactly one per language:\n' +
        CANONICAL.map((c) => `  - ${c}\n`).join('') +
        '\n',
    );
    for (const v of violations) {
      process.stderr.write(`  ${v.file}  [${v.patterns.join(', ')}]\n      → ${v.hint}\n`);
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
    `check:step-escapers — ${scanned} files scanned, no new copies` +
      (known.length > 0 ? `; ${known.length} known outstanding: ${known.join(', ')}` : '') +
      '.\n',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
