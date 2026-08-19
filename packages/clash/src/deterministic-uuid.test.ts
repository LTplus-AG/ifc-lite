/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { uuidFromSeed } from './deterministic-uuid.js';

/**
 * `uuidFromSeed` backs BCF topic guids (see deterministic-uuid.ts docstring):
 * a topic's guid must be byte-identical across re-runs so a previously
 * exported BCF topic keeps correlating with the clash it describes. There is
 * no external reference for these bits — this is our own FNV-1a + xorshift
 * mix, and no other tool reproduces it — so "correct" here means "matches
 * what we shipped", not "matches a spec".
 *
 * That makes hard-coded expected values the only test that can catch a
 * silent behavior change: comparing two calls against each other within the
 * same process (as the tests in bcf-bridge.test.ts do) only proves the
 * function is internally self-consistent, which survives *any* change to the
 * salts, the mixing order, or the version/variant nibble derivation as long
 * as the new code is still self-consistent with itself. Confirmed by
 * mutation: replacing all four salt constants in deterministic-uuid.ts with
 * different arbitrary values still produces valid-shaped, internally
 * self-consistent UUIDs, and the existing suite (368/369) does not notice.
 *
 * DO NOT "fix" a failing assertion below by regenerating the expected value
 * from the new implementation. These strings are frozen-output vectors —
 * literally today's implementation's output, captured once, not values
 * derived from any specification or external tool. Regenerating them to make
 * a red test green defeats the entire point of this file: it would silently
 * re-anchor to whatever the algorithm now produces, exactly the drift this
 * test exists to catch. If a change to deterministic-uuid.ts is intentional
 * and meant to change guids going forward, that is a breaking change for
 * every previously exported BCF file and must be called out as such (e.g. in
 * a changeset), not quietly absorbed by updating this file.
 */
describe('uuidFromSeed frozen vectors', () => {
  // Real call shape: bcf-bridge.ts uses `grp-${fnv1a(...)}` group ids
  // (grouping.ts groupId) and an `overflow:<project>:<maxTopics>:<dropped>`
  // seed for the overflow marker topic.
  it('matches the frozen vector for a real group-id seed', () => {
    expect(uuidFromSeed('grp-1a2b3c4d')).toBe('9cc9c6fe-06d6-495e-ae28-944eb3055511');
  });

  it('matches the frozen vector for the overflow-marker seed shape', () => {
    expect(uuidFromSeed('overflow:Clash report:100:5')).toBe(
      '77e351db-86c0-470e-a154-010f0d5d3529',
    );
  });

  it('matches the frozen vector for the empty-string seed', () => {
    expect(uuidFromSeed('')).toBe('48be8753-e6a6-4fa3-8be7-14cec25887f6');
  });

  // Two pairs differing in exactly one character, at opposite ends of the
  // string. stableHash elsewhere in this repo is a confirmed 32-bit,
  // prefix-coupled hash (a shared prefix can produce a related digest); these
  // pairs make sure a prefix-coupling or truncation regression in this
  // module's own hashing would flip one frozen vector without flipping its
  // sibling, rather than both silently drifting together.
  it('matches frozen vectors for seeds differing only in the last character', () => {
    expect(uuidFromSeed('group-critical-a')).toBe('87b7dadf-f988-466a-ab03-2fddc8cbdc87');
    expect(uuidFromSeed('group-critical-b')).toBe('648a28ea-f9c7-45d1-ad6c-64cbebde3b13');
  });

  it('matches frozen vectors for seeds differing only in the first character', () => {
    expect(uuidFromSeed('agroup-critical')).toBe('c6e38cee-4f22-4b6f-b6c2-b6b9fa490991');
    expect(uuidFromSeed('bgroup-critical')).toBe('bf15ccb9-f12c-4930-982f-b7e73935c99f');
  });

  // Non-ASCII seed: the fnv1a loop folds each UTF-16 code unit in two
  // byte-sized steps, so an encoding-level regression (e.g. accidentally
  // truncating to the low byte only) is a real drift source this vector can
  // catch.
  it('matches the frozen vector for a non-ASCII seed', () => {
    expect(uuidFromSeed('grüppe-übergäng-42')).toBe('cf9157a5-1b67-43f4-bed2-a696546c3dce');
  });
});
