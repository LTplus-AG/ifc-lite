/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * COMPILE-TIME contract test: this package's `GeometryDiagnostics` must stay
 * structurally identical to the canonical one in `@ifc-lite/geometry`.
 *
 * The two copies drifted silently for three releases (#3857): the server-client
 * copy never grew `schemaVersion`, `worstHosts.bbox`, `worstHosts.triangleCount`
 * or `oversizedRefDrops`, so a consumer reading a field the Rust server does
 * serialize got a type error and reached for a cast. Prose saying "keep these in
 * sync" is what failed; this file is the executable version of that sentence.
 *
 * HOW IT FAILS. The assertions below are type-level, so they are checked by
 * `pnpm typecheck` (scripts/typecheck-tests.mjs builds a program over the test
 * files), not by running this file. A field added to, removed from or retyped on
 * either side breaks the build. The runtime `expect` exists only so the file is
 * a visible test rather than a silent one.
 *
 * WHY A RELATIVE SOURCE IMPORT. `@ifc-lite/geometry` is deliberately NOT a
 * dependency of this package - see the header of `geometry-diagnostics-types.ts`
 * for why. A type-only relative import of the canonical module needs no
 * dependency edge and no built `dist/`, and `import type` is erased, so nothing
 * from the geometry package is loaded at runtime. Precedent:
 * `packages/sdk/src/sandbox.test.ts`.
 */

import { describe, expectTypeOf, it, expect } from 'vitest';
import type { GeometryDiagnostics as Canonical } from '../../geometry/src/diagnostics.js';
import type { GeometryDiagnostics as WireCopy } from './geometry-diagnostics-types.js';

/**
 * Fields this copy carries AHEAD of the canonical type, because the PR that adds
 * them there has not landed yet and this package's wire shape had to be written
 * not to collide with it.
 *
 * EMPTY, and that is the healthy state: #3691 landed
 * `totalUnsupportedItems` / `unsupportedItemsByType` on the canonical type, so
 * the two entries that used to sit here were deleted and the comparison below
 * now runs with nothing excused.
 *
 * This list is self-retiring: `AheadFieldsAreNotYetCanonical` below fails the
 * moment `@ifc-lite/geometry` gains one of these names, which is the signal to
 * delete the name from here. An entry that is merely convenient does not belong
 * in it.
 */
type FieldsAheadOfCanonical = never;

/** The allowlist above, minus anything the canonical type has since caught up on. */
type AheadFieldsAreNotYetCanonical = Extract<FieldsAheadOfCanonical, keyof Canonical>;

describe('GeometryDiagnostics wire copy vs @ifc-lite/geometry', () => {
  it('is field-for-field identical to the canonical type (checked by tsc, not at runtime)', () => {
    // Exact structural equality: same keys, same value types, same optionality,
    // nested objects included. Assignability alone would NOT do - an interface
    // with extra properties is still assignable, which is precisely the drift
    // this test exists to catch.
    expectTypeOf<Omit<WireCopy, FieldsAheadOfCanonical>>().toEqualTypeOf<Canonical>();
    expect(true).toBe(true);
  });

  it('has an allowlist of ahead-of-canonical fields that is still needed', () => {
    // Fails once the canonical type declares an allowlisted field. Fix by
    // deleting that name from `FieldsAheadOfCanonical`, not by widening it.
    expectTypeOf<AheadFieldsAreNotYetCanonical>().toEqualTypeOf<never>();
    expect(true).toBe(true);
  });
});
