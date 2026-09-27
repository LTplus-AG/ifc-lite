#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Does the release credential have the API quota this Release run needs?" (#5693)
 *
 * release.yml authenticates changesets/action (version commit, version PR,
 * per-package tags and releases) and the server-bin `gh release create` with
 * `secrets.RELEASE_PAT`. A PAT spends its OWNER's
 * quota: 5,000 REST points and 5,000 GraphQL points an hour, shared with
 * everything else that account does. When the PAT belongs to an account that
 * agent sessions also drive `gh` with, those sessions drain it, and Release
 * run 36009885836 died mid-job ("API rate limit already exceeded for user ID
 * 78563314") after `pnpm run version` had already run (a GraphQL call of
 * changesets/action). On the publish path
 * the same failure lands between `changeset publish` and the GitHub releases.
 *
 * The root fix is a credential that nothing else spends: a PAT of a dedicated
 * machine account, or a GitHub App (see RELEASE.md, "Release credential").
 * This gate is what makes a shared or drained credential visible and harmless
 * instead of a half-finished run:
 *
 *   - It reads `GET /rate_limit` (free: it does not count against the quota)
 *     BEFORE the run mutates anything or mints the 30-minute crates.io token.
 *   - Both buckets above the floor: pass.
 *   - A bucket below the floor that resets within `--max-wait`: wait for the
 *     reset, then read again. The Release concurrency group queues later runs
 *     (`queue: max`), so waiting delays a release rather than losing it.
 *   - Otherwise: fail with the account, the bucket, the reset time and the fix.
 *
 * FAIL CLOSED: an unreadable `/rate_limit` (bad or expired token, no `gh`) is
 * a failure too; the run would fail on the same credential a step later.
 *
 * Executable proof: `scripts/check-release-credential-quota.test.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { isMainEntry } from './lib/is-main-entry.mjs';

/**
 * Points one Release run can spend, per bucket, with headroom. The publish
 * path is the expensive one: changesets/action creates a GitHub release per
 * published package on REST (46 npm packages; the tags themselves may go
 * through the REST API or git depending on the action's commit mode, so
 * count them too: ~92), plus the PR lookup and the server-bin release and its
 * lookups. The version path spends a handful of GraphQL points (the version
 * commit and the PR update).
 */
export const DEFAULT_FLOOR = { core: 200, graphql: 50 };

/** How long a run may wait for a bucket to reset before it fails instead. */
export const DEFAULT_MAX_WAIT_S = 20 * 60;

/**
 * The verdict for one `/rate_limit` reading.
 *
 * `resources` is the `resources` object of `GET /rate_limit`; `nowS` is the
 * current Unix time in seconds. Returns `{ verdict: 'ok' }`,
 * `{ verdict: 'wait', waitS, short }` or `{ verdict: 'fail', short }`, where
 * `short` lists the buckets below their floor as `{ bucket, remaining, floor,
 * reset }`. A bucket missing from the reading counts as empty (fail closed).
 */
export function quotaVerdict(resources, { nowS, floor = DEFAULT_FLOOR, maxWaitS = DEFAULT_MAX_WAIT_S }) {
  const short = [];
  for (const [bucket, need] of Object.entries(floor)) {
    const r = resources?.[bucket];
    const remaining = Number.isFinite(r?.remaining) ? r.remaining : 0;
    const reset = Number.isFinite(r?.reset) ? r.reset : null;
    if (remaining < need) short.push({ bucket, remaining, floor: need, reset });
  }
  if (short.length === 0) return { verdict: 'ok' };
  if (short.some((s) => s.reset === null)) return { verdict: 'fail', short };
  // +5 s: `reset` is the second the window rolls over, and the first request
  // in that second can still be counted against the old window.
  const waitS = Math.max(0, ...short.map((s) => s.reset - nowS)) + 5;
  return waitS <= maxWaitS ? { verdict: 'wait', waitS, short } : { verdict: 'fail', short };
}

function describe(short) {
  return short
    .map((s) => {
      const at = s.reset === null ? 'unknown' : new Date(s.reset * 1000).toISOString();
      return `${s.bucket}: ${s.remaining} left, this run needs ${s.floor}, resets ${at}`;
    })
    .join('; ');
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function readResources() {
  return JSON.parse(gh(['api', 'rate_limit'])).resources;
}

/** `readResources()`, or `null` after reporting the fail-closed error. */
function tryReadResources() {
  try {
    return readResources();
  } catch (err) {
    process.stderr.write(
      `::error title=Release credential unreadable (#5693)::GET /rate_limit failed with the release credential (${String(err.message).split('\n')[0]}). ` +
        'The token is missing, expired or revoked; rotate RELEASE_PAT (see RELEASE.md, "Release credential").\n'
    );
    return null;
  }
}

/** The token owner's login, for the diagnosis. Costs one REST point, so only asked with points left. */
function owner(resources) {
  if (!(resources?.core?.remaining > 0)) return 'the RELEASE_PAT owner';
  try {
    return gh(['api', 'user', '--jq', '.login']).trim() || 'the RELEASE_PAT owner';
  } catch {
    // A GitHub App installation token has no `/user`; the name is only for the message.
    return 'the release credential';
  }
}

function sleep(s) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
}

function main(argv) {
  const maxWaitArg = argv.indexOf('--max-wait');
  const raw = maxWaitArg === -1 ? String(DEFAULT_MAX_WAIT_S) : argv[maxWaitArg + 1];
  const maxWaitS = /^\d+$/.test(raw ?? '') ? Number(raw) : NaN;
  const unknown = maxWaitArg === -1 ? argv : argv.filter((_, i) => i !== maxWaitArg && i !== maxWaitArg + 1);
  if (!Number.isFinite(maxWaitS) || unknown.length > 0) {
    process.stderr.write('usage: check-release-credential-quota.mjs [--max-wait <seconds>]\n');
    return 2;
  }
  let resources = tryReadResources();
  if (resources === null) return 2;
  let result = quotaVerdict(resources, { nowS: Date.now() / 1000, maxWaitS });
  if (result.verdict === 'wait') {
    process.stdout.write(
      `::warning title=Release credential quota low (#5693)::${describe(result.short)}. ` +
        `Waiting ${Math.ceil(result.waitS)} s for the reset. The quota belongs to ${owner(resources)} and is shared with everything else that account does; a dedicated release credential removes this wait (RELEASE.md, "Release credential").\n`
    );
    sleep(result.waitS);
    resources = tryReadResources();
    if (resources === null) return 2;
    // After one reset a second wait is not a wait for the reset any more:
    // something is still draining the account.
    result = quotaVerdict(resources, { nowS: Date.now() / 1000, maxWaitS: 0 });
  }
  if (result.verdict !== 'ok') {
    process.stderr.write(
      `::error title=Release credential out of API quota (#5693)::${describe(result.short)}. ` +
        `The quota belongs to ${owner(resources)}, and something else that uses that account spent it. ` +
        'Nothing was published or pushed by this run. Re-run it after the reset; to stop this recurring, give RELEASE_PAT a credential nothing else uses (RELEASE.md, "Release credential").\n'
    );
    return 1;
  }
  const c = resources.core;
  const g = resources.graphql;
  process.stdout.write(`release credential quota ok: core ${c.remaining}/${c.limit}, graphql ${g.remaining}/${g.limit}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
