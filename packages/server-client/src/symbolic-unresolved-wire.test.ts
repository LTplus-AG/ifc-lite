// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The server side of `symbolic_data` uses `f32::NAN` as a sentinel meaning
 * "this elevation / cross-hatch angle was never resolved". JSON has no NaN, so
 * it reaches this client as `null` — and `null` is emphatically NOT `0`, which
 * is a real elevation at datum.
 *
 * The payload under test is NOT hand-written here. It is emitted by the actual
 * Rust serializer (`rust/processing/tests/symbolic_nan_sentinel_json_roundtrip.rs`,
 * `the_typescript_wire_fixture_matches_what_the_serializer_emits`) and checked
 * in; that test fails if the wire drifts from these bytes, so a format change
 * cannot land on one side only.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SymbolicData } from './types.js';

const raw = readFileSync(
  fileURLToPath(new URL('./__fixtures__/symbolic-unresolved-wire.json', import.meta.url)),
  'utf8',
);

/**
 * Compile-time assertion: the declared type must ADMIT `null`. Back when
 * `world_y` was declared `number`, this assignment did not compile — which is
 * precisely the half-fix this test exists to prevent.
 */
const admitsUnresolved: SymbolicData['grid_axes'][number]['world_y'] = null;

describe('symbolic_data unresolved scalars on the wire', () => {
  it('admits null in the declared type', () => {
    expect(admitsUnresolved).toBeNull();
  });

  it('parses the real server payload and reads unresolved as null', () => {
    const data = JSON.parse(raw) as SymbolicData;

    expect(data.grid_axes[0].world_y).toBeNull();
    expect(data.fills[0].hatch_angle_secondary).toBeNull();
  });

  /**
   * BOUNDING CONTROL — the one that matters. A genuine `0.0` elevation must
   * survive as the number `0`, and must stay distinguishable from unresolved.
   * `Number(null)` is `0`, so a consumer that coerces instead of branching
   * invents a datum-level elevation out of "we don't know"; asserted here so
   * that trap stays visible.
   */
  it('keeps a genuine 0 elevation distinct from unresolved', () => {
    const data = JSON.parse(raw) as SymbolicData;

    const zero = data.polylines[0].world_y;
    const unresolved = data.grid_axes[0].world_y;

    expect(zero).toBe(0);
    expect(typeof zero).toBe('number');
    expect(unresolved).toBeNull();
    expect(zero).not.toBe(unresolved);

    // The coercion trap, pinned: both would read as 0 if anything used it.
    expect(Number(unresolved)).toBe(0);
  });

  it('carries resolved non-zero elevations through unchanged', () => {
    const data = JSON.parse(raw) as SymbolicData;
    expect(data.fills[0].world_y).toBe(3.5);
  });

  /**
   * `null` (unresolved) must stay distinguishable from an absent key. The Rust
   * deserializer rejects a missing `world_y` outright; on this side the
   * difference is visible as `undefined` vs `null`, so a consumer branching on
   * `=== null` never mistakes a truncated payload for a legitimate
   * "elevation unknown" signal.
   */
  it('distinguishes unresolved (null) from absent (undefined)', () => {
    const data = JSON.parse(raw) as SymbolicData;
    const present = data.grid_axes[0] as unknown as Record<string, unknown>;

    expect('world_y' in present).toBe(true);
    expect(present.world_y).toBeNull();
    expect(present.no_such_field).toBeUndefined();
    expect(present.world_y).not.toBe(present.no_such_field);
  });
});
