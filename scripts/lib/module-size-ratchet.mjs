/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure decision logic for the TypeScript module-size ratchet
 * (`scripts/check-module-size.mjs`). Split out from the tree walk so the
 * FIRING paths — a new god file, an allowlisted file over budget, a stale
 * digest, an empty/unreadable allowlist — are unit-testable against synthetic
 * inputs rather than only against the all-clean repo.
 *
 * This mirrors `rust/processing/tests/module_size_ratchet.rs` deliberately:
 * same 400-line limit, same `<budget> <path>` allowlist format, same FNV-1a
 * digest over the sorted rows, same "shrink or split, never raise" contract.
 * Two files, one rule.
 */

/** AGENTS.md: "split modules over ~400 non-generated lines". */
export const LIMIT = 400;

/**
 * Count lines exactly as Rust's `str::lines()` does, so a file's number here
 * and in the Rust ratchet mean the same thing: a trailing newline terminates
 * the last line, it does not begin an empty one. `split('\n').length` was the
 * first spelling and reported every normal file one line too big.
 */
export function countLines(source) {
  if (source === '') return 0;
  const parts = source.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/**
 * Generated code, type declarations and test/support files are not subject to
 * the split rule — the same carve-outs the Rust ratchet makes, spelled for
 * this tree:
 *  - `/generated/`: machine-emitted, nobody splits it by hand.
 *  - `*.d.ts` / `.d.mts` / `.d.cts`: declaration files are a type surface, not
 *    a module with cohesion to preserve.
 *  - `*.test.*`, `*.spec.*`, `*.bench.*` and `test|tests|__tests__|__mocks__|
 *    e2e|fixtures` directories: test code, matching the Rust gate's `/tests/`,
 *    `/examples/`, `/benches/`, `/fuzz/` and `*_test.rs` exemptions. A long
 *    table-driven test is not the debt this rule targets.
 */
export function isExempt(rel) {
  return (
    /(^|\/)generated\//.test(rel) ||
    /\.d\.(ts|tsx|mts|cts)$/.test(rel) ||
    /\.(test|spec|bench)\.(ts|tsx|mts|cts)$/.test(rel) ||
    /(^|\/)(test|tests|__tests__|__mocks__|e2e|fixtures)\//.test(rel)
  );
}

/**
 * Parse the committed allowlist into a Map of relpath -> budget. Comment and
 * blank lines are skipped; a malformed data line throws, because the file is a
 * contract and a silently dropped row is a silently unfrozen file.
 *
 * An allowlist that parses to ZERO rows throws too. Every gate in this repo
 * that shipped exiting 0 having verified nothing did it by treating "no input"
 * as "no problem"; an allowlist file that got truncated, renamed, or written
 * as pure comments must be loud, not green.
 */
export function parseAllowlist(text, label = 'allowlist') {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`${label}: empty or unreadable`);
  }
  const map = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(\S+)\s+(\S.*)$/.exec(line);
    if (!match) throw new Error(`${label}: malformed line: ${JSON.stringify(line)}`);
    const budget = Number(match[1]);
    if (!Number.isInteger(budget) || budget <= 0) {
      throw new Error(`${label}: bad budget in: ${JSON.stringify(line)}`);
    }
    const path = match[2].trim();
    if (map.has(path)) {
      throw new Error(`${label}: duplicate row for ${path} (budgets ${map.get(path)} and ${budget})`);
    }
    map.set(path, budget);
  }
  if (map.size === 0) throw new Error(`${label}: parsed 0 rows`);
  return map;
}

/**
 * FNV-1a over `path budget` rows sorted by path, so the digest is a function
 * of the allowlist's CONTENT and not of its line order. Returned as a decimal
 * string because the value does not fit a JS number exactly.
 *
 * FNV-1a rather than a platform hash for the reason the Rust side gives: the
 * value is pinned in a source file, so it must not move when a toolchain
 * moves. BigInt arithmetic here reproduces Rust's wrapping u64 multiply, and
 * `moduleSizeRatchetDigest` on the same rows returns the same number in both
 * languages (pinned in the unit tests).
 */
export function allowlistDigest(map) {
  const rows = [...map.entries()].map(([p, b]) => `${p} ${b}`).sort();
  const MASK = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(rows.join('\n'), 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x00000100000001b3n) & MASK;
  }
  return hash.toString();
}

/**
 * The ratchet decision. `files` is `[{ rel, lines }]` for every non-exempt
 * file found; `allowlist` is the parsed Map.
 *
 * Returns `{ newOffenders, grew, shrunk, missing, slack }`:
 *  - `newOffenders` (FAILS): over LIMIT with no row — a new god file.
 *  - `grew` (FAILS): allowlisted and over its recorded budget.
 *  - `shrunk` / `missing` / `slack` (ADVISORY): rows that should be deleted or
 *    lowered. Advisory only, so that a merge landing a shrink elsewhere cannot
 *    turn an unrelated PR red — the same choice the Rust gate makes.
 *
 * `slack` is the one this gate could not previously see at all. A row whose
 * budget sits ABOVE the file's current size is headroom the file may grow into
 * without any check firing, and nothing reported it: `shrunk` only notices a
 * file that fell back under LIMIT. Two such rows were already in the initial
 * allowlist (+2 and +3 lines) despite it being recorded from measured counts,
 * which is exactly how the shape goes unnoticed.
 */
export function evaluate(files, allowlist) {
  const newOffenders = [];
  const grew = [];
  const slack = [];
  const seen = new Map();
  for (const { rel, lines } of files) {
    seen.set(rel, lines);
    const budget = allowlist.get(rel);
    if (budget === undefined) {
      if (lines > LIMIT) newOffenders.push(`  ${rel}: ${lines} lines`);
    } else if (lines > budget) {
      grew.push(`  ${rel}: ${lines} lines, budget ${budget}`);
    } else if (lines < budget && lines > LIMIT) {
      slack.push(`  ${rel}: ${lines} lines, budget ${budget} (${budget - lines} lines of headroom)`);
    }
  }
  const shrunk = [];
  const missing = [];
  for (const [rel, budget] of allowlist) {
    const lines = seen.get(rel);
    if (lines === undefined) missing.push(`  ${rel} (budget ${budget})`);
    else if (lines <= LIMIT) shrunk.push(`  ${rel}: now ${lines} lines`);
  }
  newOffenders.sort();
  grew.sort();
  shrunk.sort();
  missing.sort();
  slack.sort();
  return { newOffenders, grew, shrunk, missing, slack };
}

/**
 * Rows at or under the limit are stale exemptions: the file no longer needs
 * one, so the row should be deleted rather than kept as permanent slack.
 */
export function staleRows(allowlist) {
  return [...allowlist.entries()]
    .filter(([, budget]) => budget <= LIMIT)
    .map(([rel, budget]) => `  ${rel}: budget ${budget} <= ${LIMIT}`)
    .sort();
}

/**
 * The rows `--update` would write, and — separately — which of them LOOSEN the
 * ratchet.
 *
 * `check-unused-locals.mjs --update`, the script this regeneration half is
 * modelled on, will happily raise a baseline that drifted upward, and the only
 * safeguard is a human reading the diff. A ratchet whose own regeneration
 * command can silently undo it is not a ratchet, so the two directions are
 * separated here and the caller refuses the loosening ones unless they were
 * asked for explicitly:
 *
 *  - `raised`:  an allowlisted file is now BIGGER than its budget. Recording
 *               the new count is exactly the "raise the budget instead of
 *               splitting the file" move the gate exists to prevent.
 *  - `added`:   a file crossed the limit with no row — a new exemption.
 *  - `lowered` / `removed`: tighten or delete a row; always safe to write.
 *
 * `next` is the whole allowlist that would be written: every measured file over
 * the limit, at its measured count. A file at or under the limit gets no row,
 * which is what deletes a stale exemption.
 */
export function planUpdate(files, allowlist) {
  const measured = new Map(files.map((f) => [f.rel, f.lines]));
  const next = new Map();
  const raised = [];
  const added = [];
  const lowered = [];
  const removed = [];

  for (const { rel, lines } of files) {
    const budget = allowlist.get(rel);
    if (lines <= LIMIT) {
      if (budget !== undefined) removed.push(`  ${rel}: now ${lines} lines (row deleted)`);
      continue;
    }
    next.set(rel, lines);
    if (budget === undefined) added.push(`  ${rel}: ${lines} lines (new exemption)`);
    else if (lines > budget) raised.push(`  ${rel}: ${lines} lines, budget ${budget} (+${lines - budget})`);
    else if (lines < budget) lowered.push(`  ${rel}: ${lines} lines, budget ${budget} (-${budget - lines})`);
  }
  for (const [rel, budget] of allowlist) {
    if (!measured.has(rel)) removed.push(`  ${rel} (budget ${budget}) no longer matches a tracked file`);
  }

  raised.sort();
  added.sort();
  lowered.sort();
  removed.sort();
  return { next, raised, added, lowered, removed };
}

/**
 * Re-render an allowlist file: its leading comment block verbatim, then one
 * `<budget> <path>` row per entry sorted by path, in the committed file's
 * column layout.
 *
 * The header is carried over rather than regenerated, because it is the only
 * place the rule ("SHRINK OR SPLIT") is written down and a regeneration command
 * that quietly dropped it would erase the reason the file exists.
 */
export function renderAllowlist(existingText, map) {
  const header = [];
  for (const raw of String(existingText).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) header.push(raw);
    else break;
  }
  // Case-insensitive, with the raw path as tiebreak. That reproduces the order
  // the committed allowlist was hand-maintained in (verified byte-for-byte in
  // check-module-size.test.mjs), so the first regeneration is not a 312-line
  // reorder nobody can review. Deliberately NOT `localeCompare`, which also
  // reproduces it today but varies with the host's ICU data — the digest is
  // order-independent, so a locale-dependent reorder would be an unreviewable
  // diff with no gate reporting it.
  const rows = [...map.entries()]
    .sort(([a], [b]) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      if (x !== y) return x < y ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map(([path, budget]) => `${String(budget).padStart(6)} ${path}`);
  return `${[...header, ...rows].join('\n')}\n`;
}
