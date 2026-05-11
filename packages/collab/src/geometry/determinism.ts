/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Determinism harness (spec open problem #5).
 *
 * The CRDT pipeline assumes the geometry kernel is bit-identical
 * across machines for the same params. This harness lets a CI matrix
 * run the kernel against a fixed set of param fixtures and compare
 * hashes. Drift is reported, not silently masked.
 *
 * Designed to be runtime-agnostic: pass a `kernel(params) => Mesh`
 * callable and a list of fixtures.
 */

import { hashMesh, type Mesh, type ParametricSource } from './parametric.js';

export interface DeterminismFixture {
  name: string;
  source: ParametricSource;
  params: unknown;
}

export interface DeterminismResult {
  name: string;
  hash: string;
  ok: boolean;
  /** Expected hash, when comparing against a known-good baseline. */
  expected?: string;
}

export interface DeterminismReport {
  results: DeterminismResult[];
  ok: boolean;
}

export type Kernel = (source: ParametricSource, params: unknown) => Mesh;

/**
 * Run `kernel` against every fixture and return per-fixture hashes.
 *
 * If `expected` is supplied, *every* fixture must have a matching entry
 * — a missing entry counts as a failure, not an implicit pass. This is
 * intentional: a typo in a fixture name or a forgotten baseline update
 * used to silently report `ok=true`, which made drift unobservable. If
 * you genuinely want partial baselines, omit `expected` entirely.
 */
export function runDeterminismHarness(
  kernel: Kernel,
  fixtures: readonly DeterminismFixture[],
  expected?: Record<string, string>,
): DeterminismReport {
  const results: DeterminismResult[] = [];
  let allOk = true;
  const baselineProvided = expected !== undefined;
  for (const fixture of fixtures) {
    const mesh = kernel(fixture.source, fixture.params);
    const hash = hashMesh(mesh);
    const exp = expected?.[fixture.name];
    let ok: boolean;
    if (!baselineProvided) {
      ok = true;
    } else if (exp == null) {
      // Baseline was provided but doesn't cover this fixture — refuse
      // to silently report success.
      ok = false;
    } else {
      ok = hash === exp;
    }
    if (!ok) allOk = false;
    results.push({ name: fixture.name, hash, ok, expected: exp });
  }
  return { results, ok: allOk };
}

/**
 * Default fixture set covering all built-in primitives.
 * Apps extend with their own per-platform-stable parametric library.
 */
export const DEFAULT_FIXTURES: readonly DeterminismFixture[] = [
  {
    name: 'box-1x2x3',
    source: 'box',
    params: { length: 1, width: 2, height: 3 },
  },
  {
    name: 'cylinder-r1-h2',
    source: 'cylinder',
    params: { radius: 1, height: 2, segments: 16 },
  },
  {
    name: 'extruded-rect-2x3-d4',
    source: 'extruded-area-solid',
    params: {
      profile: { type: 'rectangle', width: 2, height: 3 },
      depth: 4,
    },
  },
  {
    name: 'extruded-circle-r1-d2',
    source: 'extruded-area-solid',
    params: {
      profile: { type: 'circle', radius: 1, segments: 16 },
      depth: 2,
    },
  },
  {
    name: 'revolved-r0.5-full',
    source: 'revolved-area-solid',
    params: {
      profile: { type: 'circle', radius: 0.5, segments: 16 },
      angle: Math.PI * 2,
      segments: 16,
    },
  },
];
