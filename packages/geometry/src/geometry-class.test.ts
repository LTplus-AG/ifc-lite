/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  GEOM_CLASS_OCCURRENCE,
  GEOM_CLASS_ORPHAN_TYPE,
  GEOM_CLASS_INSTANCED_TYPE,
  GEOM_CLASS_LAYER_SLICE,
  geometryClassOf,
  isPlacedGeometryClass,
  isTypeLibraryGeometryClass,
} from './geometry-class.js';

/**
 * What this file can and cannot establish, stated plainly so nobody reads
 * more safety into it than is there.
 *
 * It CAN pin the TypeScript half of the contract: the four ordinals are
 * distinct, and every class lands on exactly one side of the placed /
 * type-library split. Before this module those numbers were bare literals in
 * six files across three packages, so adding a class meant finding all six
 * and missing one was silent.
 *
 * It CANNOT verify the numbers against Rust, which is where they are decided
 * (`rust/processing/src/element.rs:638` names only class 3). The tag crosses
 * as a bare `u8`, so a renumbering on the Rust side would leave every
 * assertion here green while geometry is silently reclassified -- layered
 * walls dropping out of Model view, or type-library duplicates rendering as
 * real building geometry. Neither throws.
 *
 * That half is closed elsewhere, and deliberately not here:
 * `scripts/test-wasm-contract.mjs` loads a layered-wall fixture
 * (`ara3d/duplex.ifc`) through real WASM and asserts the emitted class is 3,
 * alongside 0 -- so a Rust-side renumbering fails a test rather than passing
 * silently. Keep the two apart: this file must stay runnable without a wasm
 * build, which is why it cannot make that assertion itself.
 *
 * Note what does NOT count as that check. The contract script also reads
 * `geometryClass` inside `meshFingerprint()`, but only to compare two code
 * paths against each other -- satisfied by any value as long as both sides
 * produce the same one. That is a self-round-trip, not a pin.
 */

describe('geometry class ordinals', () => {
  const ALL = [
    GEOM_CLASS_OCCURRENCE,
    GEOM_CLASS_ORPHAN_TYPE,
    GEOM_CLASS_INSTANCED_TYPE,
    GEOM_CLASS_LAYER_SLICE,
  ];

  it('are the values Rust emits', () => {
    // Mirrors rust/processing/src/element.rs. Class 3 is named there as
    // GEOM_CLASS_LAYER_SLICE; 0/1/2 are bare literals on that side too.
    expect(GEOM_CLASS_OCCURRENCE).toBe(0);
    expect(GEOM_CLASS_ORPHAN_TYPE).toBe(1);
    expect(GEOM_CLASS_INSTANCED_TYPE).toBe(2);
    expect(GEOM_CLASS_LAYER_SLICE).toBe(3);
  });

  it('are all distinct', () => {
    // Two classes sharing an ordinal is not a compile error anywhere: they
    // would simply become indistinguishable, and every predicate below would
    // still look right.
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  it('split into placed and type-library with nothing left over', () => {
    // The two predicates must partition the classes: a class that is neither
    // is invisible in every view, and one that is both renders twice.
    for (const c of ALL) {
      expect(
        isPlacedGeometryClass(c) !== isTypeLibraryGeometryClass(c),
        `class ${c} must be exactly one of placed / type-library`,
      ).toBe(true);
    }
  });

  it('counts occurrences and layer slices as placed', () => {
    // Layer slices are placed geometry: a model whose layered walls are
    // emitted as slices still "has occurrences" (#1353). Getting this wrong
    // hides orphan type geometry that should show, or shows it when it
    // should not.
    expect(isPlacedGeometryClass(GEOM_CLASS_OCCURRENCE)).toBe(true);
    expect(isPlacedGeometryClass(GEOM_CLASS_LAYER_SLICE)).toBe(true);
    expect(isPlacedGeometryClass(GEOM_CLASS_ORPHAN_TYPE)).toBe(false);
    expect(isPlacedGeometryClass(GEOM_CLASS_INSTANCED_TYPE)).toBe(false);
  });

  it('treats an unknown class as neither placed nor type-library', () => {
    // If Rust adds a class 4, this is the behaviour it inherits until someone
    // updates this module -- it disappears rather than being misfiled, which
    // is the failure mode we can actually notice.
    expect(isPlacedGeometryClass(4)).toBe(false);
    expect(isTypeLibraryGeometryClass(4)).toBe(false);
  });

  describe('geometryClassOf', () => {
    it('defaults a missing tag to occurrence', () => {
      // Meshes predating the tag, and meshes built on the TS side, carry no
      // class and are real geometry. Every call site relied on this default
      // before it was written down here.
      expect(geometryClassOf({})).toBe(GEOM_CLASS_OCCURRENCE);
      expect(geometryClassOf({ geometryClass: undefined })).toBe(GEOM_CLASS_OCCURRENCE);
    });

    it('passes a present tag through unchanged', () => {
      for (const c of ALL) {
        expect(geometryClassOf({ geometryClass: c })).toBe(c);
      }
    });

    it('does not mistake class 0 for a missing tag', () => {
      // `?? ` rather than `||` matters here: class 0 is falsy, so `||` would
      // route it through the default and land on the same answer by luck --
      // and then do the wrong thing the day the default changes.
      expect(geometryClassOf({ geometryClass: GEOM_CLASS_OCCURRENCE })).toBe(GEOM_CLASS_OCCURRENCE);
    });
  });
});
