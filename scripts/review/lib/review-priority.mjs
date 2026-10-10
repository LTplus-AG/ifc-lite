/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The order in which `fitFilesToPrompt` offers a PR's patches to the prompt
 * budget when not all of them fit (#7268).
 *
 * WHY NOT PURELY LARGEST-FIRST. Largest-first maximises how many changed bytes
 * are read, which is the wrong objective once a PR mixes code with archived
 * evidence. Measured on #6584 at exact head 42cb3751: two qualification/result
 * JSON patches under `scripts/perf/evidence/` (89,519 and 71,148 bytes) were
 * admitted while the 50,318 bytes of `apps/` implementation they were evidence
 * FOR were omitted. The review reported zero findings over a diff whose
 * production half it never saw.
 *
 * THE POLICY: production source first, then tests, then docs/config, then
 * archived evidence last. Within a tier the old rule still holds -- largest
 * first, ties on path by code-point order (not `localeCompare`, whose result
 * depends on the host's ICU locale) -- so two runs of one head agree. Greedy
 * as before: a file too big for the room left does not block a smaller one,
 * in its own tier or a later one.
 *
 * NOTHING IS DROPPED BY THIS. It only decides who is admitted first; every
 * candidate not admitted is still recorded as an unreviewable row with
 * OMITTED_FOR_PROMPT_REASON and still reaches the marker's `omitted=` count.
 * The prompt ceiling is unchanged.
 *
 * THE TAXONOMY IS THE REVERT ORACLE'S, not a new one: `classifyPath` already
 * decides production vs test vs ignored (docs, `.github/`, `.changeset/`,
 * lockfiles) vs inert (binary assets) for CI. The one thing it has no bucket
 * for is archived evidence -- `scripts/perf/evidence/**.json` reads as
 * production there, because a revert of it is observable to nothing and that
 * gate never needed the distinction. So evidence is matched first, by an
 * `evidence/` directory segment: every committed archive tree
 * (`docs/architecture/evidence`, `scripts/perf/evidence`, `tests/evidence`,
 * `tests/e2e/evidence`, `tools/ifcopenshell_reference/evidence`) has that
 * shape, and no tracked path under `apps/`, `packages/` or `rust/` does.
 */

import { classifyPath } from '../../lib/revert-oracle.mjs';

/** Admission order, highest priority first. */
export const REVIEW_TIERS = Object.freeze(['production', 'test', 'docs-config', 'evidence']);

const ARCHIVED_EVIDENCE_RE = /(^|\/)evidence\//;

/**
 * @param {string} path repo-relative
 * @returns {'production'|'test'|'docs-config'|'evidence'}
 */
export function reviewTier(path) {
  if (ARCHIVED_EVIDENCE_RE.test(path)) return 'evidence';
  const kind = classifyPath(path);
  if (kind === 'production' || kind === 'test') return kind;
  return 'docs-config';
}

const RANK = new Map(REVIEW_TIERS.map((t, i) => [t, i]));

/**
 * Sort comparator over `{path, bytes}`: tier, then size descending, then path.
 * Total and host-independent, so the admitted set is a pure function of the
 * candidate list.
 */
export function compareForReview(a, b) {
  const tier = RANK.get(reviewTier(a.path)) - RANK.get(reviewTier(b.path));
  if (tier !== 0) return tier;
  if (a.bytes !== b.bytes) return b.bytes - a.bytes;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * How many omitted paths fell in each tier, in tier order, for the PARTIAL
 * REVIEW log -- so "production fully reviewed, evidence partially" is stated
 * rather than left to be inferred from a path list.
 *
 * @param {string[]} paths
 * @returns {string} e.g. `production 0, test 0, docs-config 1, evidence 5`
 */
export function omittedByTier(paths) {
  const counts = new Map(REVIEW_TIERS.map((t) => [t, 0]));
  for (const p of paths) counts.set(reviewTier(p), counts.get(reviewTier(p)) + 1);
  return REVIEW_TIERS.map((t) => `${t} ${counts.get(t)}`).join(', ');
}
