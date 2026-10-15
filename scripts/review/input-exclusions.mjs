/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generated, vendored and fixture content. Excluded for ATTENTION, not cost:
 * measured, removing these moves the mean diff ~5%, but a lockfile is tens of
 * thousands of tokens competing with the code actually under review.
 */
export const EXCLUDED = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)package-lock\.json$/,
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
  /(^|\/)pkg\//,
  /\.(ifc|ifcx|glb|gltf|png|jpg|jpeg|svg|pdf|zip|wasm|ico|parquet|bcf|woff|gif|webp)$/i,
  /(^|\/)dist\//,
  /(^|\/)api-surface\.json$/,
];
