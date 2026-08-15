/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The B4.3 exam's published salt universes, split out of run.mjs (AGENTS.md:
 * no module over ~400 non-generated lines). These are DATA, not secrets - see
 * the note on EXAM_SALTS for why publishing them is safe and why the scorer
 * still cannot be configured with one.
 */

/**
 * PUBLISHED exam salts. These are NOT production salts and must never be used
 * as one - they are in the repo so that anyone can re-run this exam and get the
 * same digits. A production salt is 32 CSPRNG bytes that exist only in the
 * scoring service's environment (BENCHMARK.md section 1b).
 *
 * They are deliberately spelled as a readable label plus 32 hex characters, so
 * they satisfy the universal salt floor (128 bits of machine-generated
 * material) while FAILING the deployment format `saltForSplit` enforces -
 * exactly 64 hex characters and nothing else. A published salt therefore cannot
 * be configured as a live one by accident: the scorer refuses it. That is the
 * whole reason the format check has two tiers; see lib/salt.mjs.
 */
export const EXAM_SALTS = [
  { label: 'exam-A', value: 'b43-exam-salt-A-4f7c0b1e9d2a48c65e81b0f4a7c93d26' },
  { label: 'exam-B', value: 'b43-exam-salt-B-1a9e6c3d70b84f25a6d3e8c9147b0f5a' },
  { label: 'exam-C', value: 'b43-exam-salt-C-c50d2f8b46e91a37d8f0b62c5e4a9713' },
];

/**
 * NUISANCE salts for the null distribution. Each one is a valid universe that
 * has nothing to do with the exam universes, so a submission built under it is
 * a sample of "a well-formed submission that knows nothing about this split".
 * That distribution - not the always-clean floor - is what an information-free
 * attack should be indistinguishable from, and it is the only way to say
 * "retains nothing" with a number instead of an adjective.
 */
export const NULL_SALTS = Array.from({ length: 24 }, (_, i) => ({
  label: `null-${i + 1}`,
  value: `b43-null-salt-${i + 1}-6d0f4b8c2e17a935d84c0be6f27a1350`,
}));
