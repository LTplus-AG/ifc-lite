/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The rules whose content arrives by the dozen. The prompt's excluded-files
 * section (prompt-paths.mjs) lists these LAST, so the lone generated file a PR
 * description names -- a regenerated .d.ts, api-surface.json, a lockfile -- is
 * not crowded past its byte cap by fixtures sorted ahead of it (#9027).
 */
const BULK = [
  /\.snap$/,
  /(^|\/)fixtures?\//,
  // Captured review-input fixtures: each one EMBEDS the diffs of a historical
  // PR, and a reviewer shown diffs-inside-a-diff misattributes them. Measured
  // on this rule's own PR: the CI reviewer quoted a line of pr-3595.json's
  // embedded patch as its `riskiest_change` in build-context-pack.mjs, and
  // proof-of-work refused the review. Same category as `fixtures/`: excluded
  // for attention, and here for attribution.
  /(^|\/)eval-cases\//,
  // Verbatim live AI evaluation streams (tests/ai-eval/live-runs/<run>/recordings): captured
  // provider output, megabytes per run, so one run alone passes MAX_PATCH_BYTES. The run's
  // summary.json and review.json stay reviewable; the manifest gate checks the recordings.
  /(^|\/)live-runs\/[^/]+\/recordings\//,
  /\.(ifc|ifcx|glb|gltf|png|jpg|jpeg|svg|pdf|zip|wasm|ico|parquet|bcf|woff|gif|webp)$/i,
  // Verbatim upstream licence texts, one file per dependency; the rest of the
  // generated licence bundle is in the rule further down.
  /^licenses\/retained\/texts\//,
];

/**
 * Generated, vendored and fixture content -- LONE rules plus BULK ones. Excluded
 * for ATTENTION, not cost: measured, removing these moves the mean diff ~5%, but
 * a lockfile is tens of thousands of tokens competing with the code actually
 * under review. LONE rules usually match a handful of files per PR; a
 * committed dist/ tree would be the exception.
 */
const LONE = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pkg\//,
  /(^|\/)dist\//,
  /(^|\/)api-surface\.json$/,
  // Generated third-party licence bundles (scripts/retained-notices.mjs): the
  // inventory manifest, its README and the concatenated THIRD_PARTY_NOTICES.txt
  // copies (the verbatim texts are a BULK rule above). Drift is gated by
  // `retained-notices.mjs --check`; the generator itself stays reviewed.
  // supplemental.json is hand-authored evidence (licence elections), so it stays reviewable.
  /^licenses\/retained\/(manifest\.json$|README\.md$|THIRD_PARTY_NOTICES\.txt$)/,
  /(^|\/)THIRD_PARTY_NOTICES\.txt$/,
];

export const EXCLUDED = [...LONE, ...BULK];

/** @param {string} path */
export function isExcluded(path) {
  return EXCLUDED.some((re) => re.test(path));
}

/** @param {string} path A LONE rule's match: listed before the bulk, even under fixtures/. */
export function isLoneExcluded(path) {
  return LONE.some((re) => re.test(path));
}
