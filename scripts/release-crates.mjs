#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publishes the publishable Rust crates to crates.io.
 *
 * Replaces the old `cargo publish … || true` chain, which silently swallowed
 * EVERY failure: duplicate-version no-ops (expected when the workspace
 * version didn't advance) looked identical to real breakage, so
 * `ifc-lite-wasm` sat broken at 2.3.0 for months and the raw-bytes core API
 * almost shipped to npm without ever reaching crates.io.
 *
 * Behaviour per crate:
 *   - version already uploaded (API record exists, not yanked) → skip the
 *     `cargo publish`
 *   - otherwise → `cargo publish`; any failure FAILS the release
 *   - EITHER WAY, poll the sparse index until the version is visible there
 *     before moving to the next crate; a poll timeout FAILS the release.
 *
 * Crates are listed in dependency order (see `scripts/lib/crates-io.mjs`).
 * `cargo publish` does NOT block until the new version is visible in the
 * index — it waits up to its own internal timeout (~60s) and then prints a
 * `warning: timed out waiting for … to be available` and carries on with
 * EXIT CODE 0. Both halves of that sentence have now caused an incident:
 * v6.0.0 (#3180) timed out on `ifc-lite-geometry` and
 * `ifc-lite-processing` could not resolve it; v6.0.1 (run 32867366010)
 * timed out on `ifc-lite-core` and `ifc-lite-geometry` could not resolve
 * `ifc-lite-core = ^6.0.1` — 5 of 7 crates left unpublished. So this script
 * polls explicitly, with a timeout that FAILS the release rather than
 * warning and continuing.
 *
 * The poll reads the SPARSE INDEX (`isInSparseIndex`), not the API record
 * that the skip pre-check reads. They diverge: the API answers from the
 * registry database, which has the version the moment the upload returns,
 * while cargo resolves the next crate against the index. On v6.0.1 the view
 * cargo got lagged by over a minute — not because regeneration is slow (it
 * took seconds; see `isInSparseIndex` for the measurements) but because the
 * CDN edge was still serving the pre-publish copy of the one index file the
 * runner had already fetched. Polling the API here would go green inside
 * exactly that window and change nothing. The poll runs on the SKIP path too: a re-run minutes
 * after a failure sees the stuck crate "already published" via the API, and
 * must still wait for its index entry before publishing the dependent that
 * failed last time.
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CRATES, readWorkspaceVersion, isPublished, isInSparseIndex, waitUntilInIndex } from './lib/crates-io.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// How long to wait for a just-published crate to appear in the crates.io
// index before failing the release outright.
//
// Sized against the CDN TTL, not against propagation. Index regeneration is
// seconds (measured 1.3-1.5s across six publishes), but the index object is
// served `cache-control: public,max-age=600`, and the crate everything
// depends on is precisely the one whose pre-publish copy the runner already
// pulled for resolution. So the worst realistic wait is that TTL, not a slow
// regeneration, and a 180s bound could not outrun it: it would fail a release
// that is fully live at origin and an immediate re-run would fail the same
// way for the remainder of the ten minutes.
//
// This is PER CRATE, but the worst case does not multiply by the seven of
// them. The TTL clocks run concurrently: waiting out one crate's stale edge
// also ages every other crate's, and only a crate whose index file the runner
// already fetched can be stale at all. So the realistic ceiling is about one
// TTL for the whole run, not seven. The `release` job sets no
// `timeout-minutes`, so it has GitHub's 360-minute default, and even the naive
// 7 x 11 = 77 minutes would not be killed mid-poll. That matters because a
// killed job reports nothing, while this failure path reports why.
const PUBLISH_POLL_INTERVAL_MS = 5000;
const PUBLISH_POLL_TIMEOUT_MS = 660_000;

// The per-crate cap above is not a bound on the RELEASE. Seven crates at 660s
// is 77 minutes, against a CARGO_REGISTRY_TOKEN that `release.yml` documents as
// short-lived, 30 minutes from the mint, at lines 13, 205 and 243. Spend longer
// than the token lasts and a later `cargo publish` fails AUTHENTICATION with
// earlier crates already on the registry: the same half-publish this poll exists
// to prevent, wearing an error that points at auth rather than propagation.
//
// So the loop carries one wall-clock budget for all crates and gives each crate
// whatever is left of it, capped by the per-crate value.
//
// BE EXACT ABOUT WHAT THIS BOUNDS, because it is less than it looks.
//
// It bounds the publish phase: everything from the first `cargo publish` to the
// last index wait, INCLUDING the seven `cargo publish` invocations themselves,
// which run full verification builds (no `--no-verify`) and cargo's own ~60s
// index wait each. It does NOT bound token consumption. The token is minted at
// `release.yml`'s auth step, and between that and this loop the changesets step
// runs a second `pnpm build`, `test:esm`, and the entire npm publish with
// per-tarball provenance. None of that is charged here, so total consumption is
// (elapsed since mint) + this budget, which is not bounded above by 900s.
//
// Bounding the real constraint needs the mint timestamp plumbed in from the
// workflow and the deadline taken as the earlier of the two — this is #3258,
// closed by `tokenMintedAtMs` below. When it is supplied, the deadline is
// whichever comes first: this budget, or the token's own claimed lifetime.
// When it is NOT supplied (a manual/local run with no minted token), this
// constant is the only bound, same as before #3258 — it stops the unbounded
// 77-minute case but not total token consumption.
//
// For the same reason, do not read 900s as "enough for one 600s CDN TTL stall
// plus slack". That subtraction ignores the seven verification builds inside
// the same budget and has not been measured. Raising it to fit a worst case of
// cap x crates is worse still: that worst case cannot be afforded at all.
//
// The 30-minute figure is this repo's own claim in release.yml, not something
// read off `crates-io-auth-action`, whose action.yml says only "temporary".
const PUBLISH_PHASE_BUDGET_MS = 900_000;

// The token's claimed lifetime — same unverified 30-minute figure as above,
// this repo's own claim (release.yml lines 13, 205, 243), not something
// `crates-io-auth-action` exposes (its action.yml outputs only `token`, no
// expiry).
const CRATES_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

// Subtracted from CRATES_TOKEN_LIFETIME_MS before treating it as a deadline.
// `tokenMintedAtMs` is stamped by a workflow step that runs AFTER the auth
// action returns, not at the instant the token is actually issued, and the
// gap between "cargo publish presents the token" and "the registry checks
// it" is not zero either. This margin keeps that slack from being counted as
// usable budget.
const CRATES_TOKEN_MARGIN_MS = 60_000;

/**
 * Reads `CRATES_TOKEN_MINTED_AT_MS` from an env-like object. Returns
 * `undefined` when unset (a manual/local run with no minted token — the
 * budget-only deadline still applies) and THROWS when set but not a finite
 * epoch-milliseconds number, rather than letting a malformed value silently
 * defeat the bound: an un-validated NaN propagates through Math.min and every
 * `<= 0` / `<` comparison below without ever being caught, which is exactly
 * how a non-numeric budget was found to hang the release forever (see the
 * PR/issue discussion on #3258). Validating at this boundary is what makes
 * that latent failure mode unreachable once this value is read from
 * `process.env` in `main()`.
 */
export function parseTokenMintedAtMs(env = process.env) {
  const raw = env.CRATES_TOKEN_MINTED_AT_MS;
  // Trimmed before the empty-string check, not after: a whitespace-only value
  // (e.g. a step output that came back `' '`) is not `=== ''`, so it used to
  // fall through to `Number(' ')`, which is 0 — not NaN, so the finite check
  // below let it pass. An epoch-ms deadline of 0 is 1970, already expired, so
  // the run aborted the crates phase before publishing the first crate, AFTER
  // npm had already published — manufacturing exactly the half-release this
  // script exists to prevent.
  const trimmed = raw === undefined ? undefined : raw.trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  const parsed = Number(trimmed);
  // `<= 0` alongside the finiteness check: a non-positive epoch timestamp
  // (0, or a negative value from a misconfigured step) is not malformed in
  // the NaN sense, but it is not a real mint time either, and treating it as
  // one manufactures the same already-expired-deadline half-release above.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `CRATES_TOKEN_MINTED_AT_MS is set to ${JSON.stringify(raw)}, which is not a positive, ` +
        `finite number of milliseconds since the epoch. Refusing to start the crates.io ` +
        `publish phase with a token-budget deadline that cannot be computed, rather than ` +
        `silently falling back to an unbounded one or to an already-expired one.`
    );
  }
  return parsed;
}

export async function publishAllCrates({
  crates = CRATES,
  version,
  cwd = rootDir,
  publishFn = (crate) =>
    execSync(`cargo publish -p ${crate} --allow-dirty`, { cwd, stdio: 'inherit' }),
  // "Has this version already been UPLOADED?" — the API record, which the
  // publish request itself writes. Decides only whether to run `cargo
  // publish` again.
  preCheckFn = isPublished,
  // "Can the next `cargo publish` RESOLVE this version?" — the sparse index,
  // the only thing cargo consults. Decides whether to move down the list.
  // These are different facts with different propagation; conflating them is
  // the v6.0.1 incident (see the header).
  indexCheckFn = isInSparseIndex,
  intervalMs = PUBLISH_POLL_INTERVAL_MS,
  timeoutMs = PUBLISH_POLL_TIMEOUT_MS,
  totalBudgetMs = PUBLISH_PHASE_BUDGET_MS,
  // Epoch-ms timestamp of when the CARGO_REGISTRY_TOKEN was minted, stamped
  // by `release.yml` right after the OIDC exchange and plumbed down through
  // `pnpm run release` as `CRATES_TOKEN_MINTED_AT_MS`. When supplied, the
  // deadline below is capped by the token's own claimed lifetime — not just
  // this function's own budget — so time already spent between the mint and
  // this call (a second build, test:esm, the whole npm publish; see the
  // header) is charged against it. `undefined` (no minted token — a
  // manual/local run) falls back to the budget-only deadline this function
  // has always used.
  tokenMintedAtMs,
  sleepFn,
} = {}) {
  // `main()` only ever passes a value that survived `parseTokenMintedAtMs`,
  // but this function is also called directly (every test in this file does,
  // and so could a future internal caller), and a non-finite value here is
  // worse than a missing one: `Math.min(x, NaN)` is `NaN`, so `tokenDeadline`
  // going NaN would poison `budgetDeadline` too and every `<= 0` / `<`
  // comparison against it below is false for NaN, which disarms BOTH the
  // token bound and the pre-existing release-wide budget it is supposed to
  // tighten. Guarding here, not just in `parseTokenMintedAtMs`, is what makes
  // that NaN-falls-through shape unreachable regardless of caller.
  if (tokenMintedAtMs != null && !Number.isFinite(tokenMintedAtMs)) {
    throw new Error(
      `tokenMintedAtMs is ${String(tokenMintedAtMs)}, which is not a finite number ` +
        `of milliseconds since the epoch. Refusing to start the crates.io publish phase ` +
        `with a token-budget deadline that cannot be computed, rather than silently ` +
        `disarming both the token bound and the release-wide budget.`
    );
  }
  const startedAt = Date.now();
  const budgetOnlyDeadline = startedAt + totalBudgetMs;
  const tokenDeadline =
    tokenMintedAtMs == null ? undefined : tokenMintedAtMs + CRATES_TOKEN_LIFETIME_MS - CRATES_TOKEN_MARGIN_MS;
  // One deadline for the whole run, not one per crate. See the note on
  // PUBLISH_PHASE_BUDGET_MS: the binding constraint is the registry token,
  // which does not restart between crates. Whichever of the two candidate
  // deadlines is EARLIER wins — a large release-wide budget must not paper
  // over a token that is already close to (or past) its own lifetime.
  const budgetDeadline = tokenDeadline === undefined ? budgetOnlyDeadline : Math.min(budgetOnlyDeadline, tokenDeadline);
  const boundByToken = tokenDeadline !== undefined && tokenDeadline < budgetOnlyDeadline;
  // Seconds-from-now this run actually has, for the messages below. Equal to
  // `totalBudgetMs` whenever the token isn't the tighter bound, so every
  // pre-#3258 message stays byte-identical when no token is supplied.
  const effectiveBudgetMs = budgetDeadline - startedAt;

  for (const crate of crates) {
    // BEFORE the publish, not after. Placed below it, this guard still ran
    // `cargo publish` for the crate it then named as "not published" — one
    // irreversible upload past the point it had decided further uploads were
    // unsafe, which is the failure it exists to prevent.
    const budgetLeftMs = budgetDeadline - Date.now();
    if (budgetLeftMs <= 0) {
      throw new Error(
        `Ran out of publish-phase budget before ${crate}@${version}, which has NOT ` +
          `been published. The release has spent its whole ` +
          `${Math.round(effectiveBudgetMs / 1000)}s allowance on publishing and on waiting ` +
          `for crates to become resolvable` +
          (boundByToken
            ? ` — this run is bounded by the crates.io token's own remaining lifetime ` +
              `(minted at ${new Date(tokenMintedAtMs).toISOString()}), tighter here than the ` +
              `${Math.round(totalBudgetMs / 1000)}s release-wide budget`
            : '') +
          `. The crates.io token from ` +
          `crates-io-auth-action is short-lived (this repo's release.yml documents 30 ` +
          `minutes from the mint), so publishing further crates now risks failing on ` +
          `AUTHENTICATION with earlier crates already on the registry. Stopping while ` +
          `the failure is still legible. Re-running is safe: already-published crates ` +
          `are not re-published, and a re-run mints a fresh token.`
      );
    }
    // The already-published pre-check is an OPTIMISATION, not a gate: a
    // registry error here (one that outlasted `cratesIoGet`'s retry budget)
    // must not abort a release part-way down this list. Fall through to the
    // publish attempt instead — `cargo publish` refuses a duplicate version
    // loudly and by name, which is a far better failure than exiting with
    // some crates up and some not.
    //
    // A YANKED version reads as NOT published (see `isPublished`), so this
    // re-attempts the publish rather than skipping it — and crates.io does not
    // free a version number on a yank, so that attempt is expected to be
    // refused as a duplicate. Recovering from a bad crate publish means a new
    // version, not a yank-and-re-run.
    let alreadyPublished = false;
    try {
      alreadyPublished = await preCheckFn(crate, version);
    } catch (err) {
      console.warn(
        `⚠️  Could not ask crates.io whether ${crate}@${version} is already published ` +
          `(${err.message}) — attempting the publish anyway.`
      );
    }
    if (alreadyPublished) {
      console.log(`⏭️  ${crate}@${version} already on crates.io — not publishing it again`);
    } else {
      console.log(`📦 Publishing ${crate}@${version} …`);
      publishFn(crate);
    }

    // Poll the index on BOTH paths, the skip path included. On a re-run
    // shortly after a failure, the stuck crate is "already published" by the
    // API record — skipping straight past it would re-create the original
    // failure at its first dependent if the index still has not caught up.
    console.log(`⏳ Waiting for ${crate}@${version} to appear in the crates.io index …`);
    // Measured HERE, not reused from the guard above. `publishFn` runs a full
    // verification build between the two points, and sizing the wait from the
    // pre-publish remainder let that build's time escape the budget entirely:
    // with a 900s budget and a 400s publish, the stale remainder still exceeded
    // the 660s cap, so the cap won, the wait ran in full, the phase ended 160s
    // past the deadline, and the message blamed the cap without mentioning the
    // budget. The budget was silently defeated for exactly the crate whose
    // publish had consumed it.
    const remainingMs = budgetDeadline - Date.now();
    // Whichever binds first. The per-crate cap keeps one stuck crate from
    // eating the whole run; the budget keeps the run inside the token.
    const thisWaitMs = Math.max(0, Math.min(timeoutMs, remainingMs));
    const { ok, waitedMs, attempts, lastError } = await waitUntilInIndex(crate, version, {
      checkFn: indexCheckFn,
      intervalMs,
      timeoutMs: thisWaitMs,
      ...(sleepFn ? { sleepFn } : {}),
    });
    if (!ok) {
      const boundedByBudget = remainingMs < timeoutMs;
      throw new Error(
        `${crate}@${version} did not appear in the crates.io index within ` +
          `${Math.round(thisWaitMs / 1000)}s (${attempts} checks)` +
          (boundedByBudget
            ? `, which was the remainder of the ${Math.round(effectiveBudgetMs / 1000)}s ` +
              `release-wide budget rather than the ${Math.round(timeoutMs / 1000)}s ` +
              `per-crate cap` +
              (boundByToken ? ` (itself capped by the crates.io token's remaining lifetime)` : ``) +
              `. `
            : `. `) +
          `The upload succeeded (or the version was already uploaded), but the index ` +
          `cargo resolves against has not caught up — publishing the next crate now ` +
          `would fail to resolve this one. Failing the release rather than racing it. ` +
          // Two different causes need two different remedies. Cut short by the
          // budget, the index may be perfectly healthy and the answer is a fresh
          // token; stuck at the cap, the answer is to look at the CDN edge.
          // Giving the CDN remedy for a budget stop sends the operator to
          // inspect something that was never the problem.
          (boundedByBudget
            ? `The wait was cut short by the budget, not by a stuck index, so the ` +
              `index may be fine. The crates.io token is short-lived; re-run to mint ` +
              `a fresh one. Already-published crates are not re-published, so a ` +
              `re-run resumes rather than repeating.`
            : `Re-running is safe (already-published crates are not re-published), ` +
              `but if the cause is a stale CDN edge rather than the origin, an ` +
              `immediate re-run hits the same cached copy: check ` +
              `\`curl -sI https://index.crates.io/<path>\` for last-modified and age, ` +
              `and if the origin already has the version, wait out the remaining ` +
              `max-age.`) +
          // Distinguishes "the index never caught up" from "crates.io was
          // erroring the whole time" — the same message for both would send
          // the operator hunting a propagation problem during an outage.
          (lastError ? ` Last error from crates.io: ${lastError.message}` : '')
      );
    }
    console.log(`✅ ${crate}@${version} visible in the index (${Math.round(waitedMs / 1000)}s, ${attempts} check(s))`);
  }
}

async function main() {
  const version = readWorkspaceVersion(rootDir);
  // Validated at this boundary, once, before anything else runs — see
  // `parseTokenMintedAtMs`. Unset (no `release.yml` step wired it in) falls
  // back to the budget-only deadline `publishAllCrates` has always used.
  const tokenMintedAtMs = parseTokenMintedAtMs();
  await publishAllCrates({ version, cwd: rootDir, tokenMintedAtMs });
}

// Only run when invoked directly (`node scripts/release-crates.mjs`), not
// when imported by a test.
if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
