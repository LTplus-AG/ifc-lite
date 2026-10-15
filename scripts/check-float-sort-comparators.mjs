#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GATE for issue #7674: non-total float comparators in Rust sorts.
 *
 * `a.partial_cmp(&b).unwrap_or(Ordering::Equal)` makes NaN "equal" to every
 * number, which is not transitive. Since Rust 1.81, `sort_by` and friends may
 * panic on a comparator that is not a total order, and the wasm build is
 * `panic = abort`: one NaN from an uploaded file or a JS caller traps the
 * shared instance. #7674 measured the panic on the pinned toolchain for the
 * clash BVH, SpacePlate, the DFJSON storey sort and voids' `thin_axis`.
 * `partial_cmp(..).unwrap()` is the same defect with a guaranteed panic.
 *
 * The replacements, per #7674's policy (charter #7670, D11): reject NaN at an
 * input-admission boundary where one exists; otherwise order with
 * `ifc_lite_geometry::cmp_f64_nan_last` (identical to `partial_cmp` for
 * numbers, NaN last) or `f64::total_cmp`. rust/AGENTS.md forbids a blanket
 * clippy rewrite, so this gate names the call instead of rewriting it.
 *
 * Run: `node scripts/check-float-sort-comparators.mjs`
 *      (also `pnpm check:float-sort-comparators`).
 *
 * ## What it flags
 *
 * EVERY use of `partial_cmp` in a production `.rs` file that is not a
 * definition (`fn partial_cmp`): method calls, UFCS (`PartialOrd::partial_cmp`,
 * `f64::partial_cmp`, `<f64 as PartialOrd>::partial_cmp`), a path passed as a
 * value, and a `use ... partial_cmp as x` rename. Matching the bad *fallback*
 * instead (`unwrap_or(Equal)`) was tried first and missed ordinary spellings:
 * `unwrap_or_else(|| Equal)`, `map_or(Equal, ..)`, `match .. None => Equal`,
 * `if let .. else { Equal }`, a renamed `Ordering`, deeply nested arguments
 * (#7706 review). The call itself is rare in production code, so naming it is
 * cheap: a legitimate use, such as the helper itself or a `match` that handles
 * `None` on purpose, takes an allowlist row with a reason.
 *
 * Test files (`tests/`, `benches/`, `tests.rs`, `*_tests.rs`) are not
 * flagged: a panic there is a test failure, not an abort.
 *
 * Comments and string, raw-string and char literals are blanked before
 * matching, so prose that quotes the call is not a hit.
 *
 * ## Allowlist and vacuity
 *
 * `scripts/float-sort-comparator-allowlist.txt` holds `<count> <path>  #
 * reason` rows. A file's hits must equal its row's count: more fails, fewer
 * fails as stale, so a removed use forces its row out. The scan fails loudly
 * when a root is missing, when it reads fewer than FILE_FLOOR files, or when
 * it sees fewer than PARTIAL_CMP_FLOOR `partial_cmp` uses across all files,
 * tests included (a broken walker or comment stripper would otherwise report a
 * clean tree).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOTS = ['rust', 'apps/server'];
export const ALLOWLIST_PATH = join(ROOT, 'scripts', 'float-sort-comparator-allowlist.txt');
export const FILE_FLOOR = 500;
export const PARTIAL_CMP_FLOOR = 30;
const SKIP_DIRS = new Set(['target', 'node_modules', '.git', 'pkg']);

/** A use of `partial_cmp` that is not its definition (`fn partial_cmp`). */
const USE = /\bpartial_cmp\b/g;
const DEFINITION = /\bfn\s+$/;

/** Test-only sources, where a NaN panic is a test failure, not an abort. */
export function isTestPath(path) {
  return /(^|\/)(tests|benches)\//.test(path) || /(^|\/)(tests|[^/]*_tests)\.rs$/.test(path);
}

/** Replace a literal or comment with spaces, keeping its newlines. */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/**
 * Blank out comments and string, raw-string and char literals, keeping
 * newlines so line numbers hold. Literals are walked, not regex-matched, so a
 * `//` or a `"` inside one is not misread, and text quoting the pattern in a
 * literal is not a hit.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    const prev = src[i - 1] ?? '';
    const raw = c === 'r' && (!/\w/.test(prev) || (prev === 'b' && !/\w/.test(src[i - 2] ?? '')))
      ? /^r(#*)"/.exec(src.slice(i, i + 260))
      : null;
    const chr = c === "'" ? /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'\n])'/.exec(src.slice(i, i + 12)) : null;
    if (raw) {
      const close = `"${raw[1]}`;
      const end = src.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? src.length : end + close.length;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (chr) {
      out += blank(chr[0]);
      i += chr[0].length;
    } else if (c === '"') {
      const start = i++;
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      out += blank(src.slice(start, ++i));
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      let depth = 0;
      do {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; }
        else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; }
        else { if (src[i] === '\n') out += '\n'; i++; }
      } while (i < src.length && depth > 0);
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Every hit in one file: `{ path, line, pattern, text }`; `uses` counts all. */
export function scanSource(path, src) {
  const code = stripComments(src);
  const test = isTestPath(path);
  const lines = code.split('\n');
  const hits = [];
  let uses = 0;
  for (const m of code.matchAll(USE)) {
    if (DEFINITION.test(code.slice(Math.max(0, m.index - 16), m.index))) continue;
    uses++;
    if (test) continue;
    const line = code.slice(0, m.index).split('\n').length;
    hits.push({ path, line, pattern: 'partial_cmp', text: lines[line - 1].trim() });
  }
  return { hits, partialCmps: uses };
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (name.endsWith('.rs')) out.push(abs);
  }
}

/** Parse `<count> <path>  # reason` rows into a Map of path -> count. */
export function parseAllowlist(text) {
  const rows = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\S+)$/.exec(line);
    if (!m || !/#\s*\S/.test(raw)) throw new Error(`allowlist row needs "<count> <path>  # reason": ${raw}`);
    if (rows.has(m[2])) throw new Error(`duplicate allowlist row: ${m[2]}`);
    rows.set(m[2], Number(m[1]));
  }
  return rows;
}

export function runCheck(root, {
  roots = ROOTS,
  allowlist = new Map(),
  fileFloor = FILE_FLOOR,
  partialCmpFloor = PARTIAL_CMP_FLOOR,
} = {}) {
  const errors = [];
  const files = [];
  for (const r of roots) {
    const abs = join(root, r);
    if (!existsSync(abs)) {
      errors.push(`scan root missing: ${r}`);
      continue;
    }
    walk(abs, files);
  }
  if (files.length < fileFloor) errors.push(`refusing a suspiciously small scan: ${files.length} .rs files`);
  let partialCmps = 0;
  const byPath = new Map();
  for (const abs of files) {
    const path = relative(root, abs).split(sep).join('/');
    const r = scanSource(path, readFileSync(abs, 'utf8'));
    partialCmps += r.partialCmps;
    if (r.hits.length) byPath.set(path, r.hits);
  }
  if (partialCmps < partialCmpFloor) {
    errors.push(`saw only ${partialCmps} partial_cmp uses (floor ${partialCmpFloor}); is the scanner broken?`);
  }
  const violations = [];
  for (const [path, hits] of byPath) {
    const allowed = allowlist.get(path) ?? 0;
    if (hits.length > allowed) violations.push(...hits);
  }
  const stale = [];
  for (const [path, count] of allowlist) {
    const found = byPath.get(path)?.length ?? 0;
    if (found < count) stale.push({ path, count, found });
  }
  return { errors, violations, stale, scanned: files.length, partialCmps };
}

function main() {
  const allowlist = parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const { errors, violations, stale, scanned, partialCmps } = runCheck(ROOT, { allowlist });
  for (const e of errors) console.error(`error: ${e}`);
  for (const v of violations) {
    console.error(
      `${v.path}:${v.line}: ${v.pattern}: ${v.text}\n` +
        '  partial_cmp is not a total order on NaN; a sort/min/max built on it may\n' +
        '  panic (abort in wasm). Use ifc_lite_geometry::cmp_f64_nan_last or\n' +
        '  f64::total_cmp, reject NaN at the input boundary, or (for a use that\n' +
        '  handles None on purpose) add an allowlist row with a reason (#7674).',
    );
  }
  for (const s of stale) {
    console.error(
      `stale allowlist row: ${s.count} ${s.path} (found ${s.found}); lower or delete it in ` +
        'scripts/float-sort-comparator-allowlist.txt',
    );
  }
  if (errors.length || violations.length || stale.length) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `float sort comparator gate passed (${scanned} .rs files, ${partialCmps} partial_cmp uses, ` +
      `${allowlist.size} allowlisted file(s))`,
  );
}

if (isMainEntry(import.meta.url)) main();
