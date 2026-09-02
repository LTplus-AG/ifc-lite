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
 * digest over the sorted rows, same "shrink or split" preference. Two files,
 * one rule -- with one asymmetry worth stating rather than glossing: the TS
 * side has a regenerate command with a sanctioned raise inside it (`--update
 * --allow-raise`); the Rust twin has no regenerate command at all, so a raise
 * there is a hand edit of the allowlist and its pinned digest. Neither side
 * makes a raise impossible -- module_size_ratchet.rs records one that reached
 * main that way (#2658) -- both make it cost a reviewable line.
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
 *
 * The suffix regexes carry `.mjs`/`.cjs` since #3672 brought Node scripts into
 * the walk; a `*.test.mjs` that stayed non-exempt would have seeded ~70 test
 * files into the allowlist on day one.
 */
export function isExempt(rel) {
  return (
    /(^|\/)generated\//.test(rel) ||
    /\.d\.(ts|tsx|mts|cts)$/.test(rel) ||
    /\.(test|spec|bench)\.(ts|tsx|mts|cts|mjs|cjs)$/.test(rel) ||
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
 * The SCOPE a row's digest belongs to: `packages/<name>`, `apps/<name>`,
 * `rust/<crate>`, or the first path segment for anything else.
 *
 * This is the whole point of sharding (#3291). One repo-wide digest made every
 * open PR touching ANY budget conflict with every other one, because they all
 * rewrote the same pinned line -- regardless of whether they touched the same
 * code. The batch that prompted this was georeferencing, marine spatial parts,
 * material tables, graphic overrides and schema-downgrade trimming: they shared
 * this file and nothing else.
 *
 * What it buys, on that batch's four PRs and their six pairs: four pairs become
 * independent, two still collide because they share `apps/viewer` and
 * `packages/parser`. So this removes CROSS-scope coupling, not within-scope,
 * and both allowlists are concentrated (48% of rows here are `apps/viewer`).
 * The residual is one line and `pnpm lint:module-size-baseline` resolves it.
 *
 * Two levels, not one, and not three. `packages` alone would still couple every
 * package to every other, which is most of the contention.
 *
 * Three is not "too fine" -- it is a NO-OP, which is a better reason to stop
 * here and the one an earlier draft of this comment got wrong. Segment 3 is
 * `src` for 307 of 309 rows in this allowlist and 65 of 65 in the Rust one, so
 * `packages/export/src` is the same partition with `/src` appended to every
 * key. Four levels would genuinely split the dominant scopes, at the cost of a
 * pin nobody reads and a file that silently changes shard when it moves between
 * directories.
 */
export function allowlistScope(path) {
  const parts = String(path).split('/');
  if (parts.length >= 2 && (parts[0] === 'packages' || parts[0] === 'apps' || parts[0] === 'rust')) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || 'other';
}

/**
 * Per-scope digests: `Map<scope, digest>`, each computed by `allowlistDigest`
 * over that scope's rows alone.
 *
 * Deliberately reuses `allowlistDigest` rather than re-deriving the hash, so a
 * single-scope allowlist produces the same value both ways and the Rust parity
 * pin keeps meaning what it meant.
 */
export function allowlistDigests(map) {
  const byScope = new Map();
  for (const [path, budget] of map.entries()) {
    const scope = allowlistScope(path);
    if (!byScope.has(scope)) byScope.set(scope, new Map());
    byScope.get(scope).set(path, budget);
  }
  return new Map([...byScope.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([s, m]) => [s, allowlistDigest(m)]));
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
 *
 * `changed` SCOPES the re-recording to the paths a change actually touched
 * (#3398). Pass `null` for the repo-wide behaviour; pass a Set of relative
 * paths and every other row is carried into `next` at its COMMITTED budget and
 * contributes to none of the four lists — with ONE exception, which is not a
 * leak but the point: a STALE row is still removed out of scope. A row at or
 * under the limit grants no exemption and is already a hard gate failure, and a
 * row whose file the walk never saw grants an exemption to nothing, so neither
 * is something another change can still need. A valid out-of-scope exemption is
 * never touched; a dead one is. (`grantsNoExemption` below carries the full
 * rule, including why the measured loop must also check the FILE.) Scoping is not a nicety: `slack` and
 * `shrunk` are advisory by design (see `evaluate`), so headroom accumulates on
 * main until some later `--update` — run by whoever, for whatever reason —
 * re-records all of it. Measured on an unmodified checkout of afa717bcf: 11
 * rows rewritten and 5 digest lines moved with a clean `git status`. Two PRs
 * regenerating in one window then carry identical hunks and collide over
 * changes neither of them made, which is the collision #3398 was filed for.
 */
export function planUpdate(files, allowlist, changed = null) {
  const inScope = (rel) => changed === null || changed.has(rel);
  // Scoping exists so a regeneration cannot delete an exemption someone else
  // still needs. A row at or under the limit grants no exemption — `staleRows`
  // already fails the gate on it — so it is not something anyone can need, and
  // carrying it forward would leave the documented regeneration command unable
  // to fix a hard failure it used to fix.
  //
  // This predicate answers "does the ROW grant anything", nothing more. Whether
  // dropping it is safe depends on the FILE, and the two call sites differ:
  // the measured loop must also check `lines <= LIMIT` (dropping a sub-limit
  // row off an over-limit file strands it as a `newOffenders` failure no scoped
  // rerun can reach), while the vanished loop needs no such check because there
  // is no file left to strand. An earlier version of this comment said
  // "dropping it is safe at any scope", which was true of every case it was
  // written against and false of the one above.
  const grantsNoExemption = (budget) => budget !== undefined && budget <= LIMIT;
  // Both loops below reach this case, and the two messages must not drift.
  const grantedNothing = (rel, budget) =>
    `  ${rel}: budget ${budget} <= ${LIMIT} granted nothing (row deleted)`;
  const measured = new Map(files.map((f) => [f.rel, f.lines]));
  const next = new Map();
  const raised = [];
  const added = [];
  const lowered = [];
  const removed = [];

  for (const { rel, lines } of files) {
    const budget = allowlist.get(rel);
    if (!inScope(rel)) {
      // The `lines <= LIMIT` half is the FILE's condition, not the row's --
      // see `grantsNoExemption` above for why the two call sites differ.
      if (grantsNoExemption(budget) && lines <= LIMIT) removed.push(grantedNothing(rel, budget));
      else if (budget !== undefined) next.set(rel, budget);
      continue;
    }
    if (lines <= LIMIT) {
      if (budget !== undefined) removed.push(`  ${rel}: now ${lines} lines (row deleted)`);
      continue;
    }
    next.set(rel, lines);
    if (budget === undefined) added.push(`  ${rel}: ${lines} lines (new exemption)`);
    else if (lines > budget) raised.push(`  ${rel}: ${lines} lines, budget ${budget} (+${lines - budget})`);
    else if (lines < budget) lowered.push(`  ${rel}: ${lines} lines, budget ${budget} (-${budget - lines})`);
  }
  // A row whose file the walk never saw: gone, renamed, or now exempt. Dropping
  // it is only OUR call when the change touched that path; otherwise the row
  // stays, because a row deleted here is an exemption someone else still needs
  // — unless it grants no exemption at all, which nobody can need.
  for (const [rel, budget] of allowlist) {
    if (measured.has(rel)) continue;
    if (inScope(rel)) removed.push(`  ${rel} (budget ${budget}) no longer matches a tracked file`);
    else if (grantsNoExemption(budget)) removed.push(grantedNothing(rel, budget));
    else next.set(rel, budget);
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
