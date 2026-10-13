/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bound on one unit resolution in `project-units.ts` (#7547): the
 * TypeScript twin of `UnitWalk` in `rust/core/src/project_units/mod.rs`
 * (#4603). It has the same depth and read limits, plus a 64 KiB cap on the
 * bytes of charged reads that Rust does not have. It differs in what the read
 * budget counts, and it remembers free reads inside the top-level unit.
 *
 * `IfcDerivedUnit -> IfcDerivedUnitElement -> Unit` is a walk over
 * file-supplied references. The schema types that `Unit` as an `IfcNamedUnit`,
 * so a real derived unit is flat: its elements name SI, conversion-based or
 * context-dependent units, never another derived unit. The reader follows
 * whatever the file names, though. Before #7547 only the native read path
 * carried a path set, and the parsed-source path had no bound at all. A
 * derived unit that names itself threw `RangeError: Maximum call stack size
 * exceeded`, and so did a long acyclic chain. An acyclic fan-out ran for
 * seconds and composed a symbol exponential in its depth. AGENTS.md "Bounding
 * walks over file-supplied references" names the three mechanisms; each one
 * here closes one of them:
 *
 * - `path` (insert on the way in, remove on the way out): a repeat is a cycle.
 * - `MAX_UNIT_RESOLVE_DEPTH`: one path's length, so the stack stays bounded
 *   while the path set never fires on an acyclic chain.
 * - `MAX_UNIT_RESOLVE_READS` and `MAX_UNIT_RESOLVE_BYTES`: the reads a walk
 *   may be charged, and the bytes those reads may parse. That bounds an
 *   acyclic fan-out, which neither of the others sees, and with it the
 *   symbol composed.
 *
 * What is charged follows the schema. Inside the top-level unit, a read is
 * free when the index types its target as the schema allows at that place
 * ({@link FLAT_UNIT}). So a flat derived unit of any width (`Elements` is
 * `SET [1:?]`) resolves as before. Every other read is charged before it is
 * made. That covers a nested derived unit, one named as the `Unit` of another
 * derived unit's element, and every read below it. It also covers any target
 * the schema forbids, such as an element whose `Unit` is not a unit. Rust charges every
 * decode instead, so there a flat unit of 128 or more SI elements is refused.
 *
 * Each free read inside the top-level unit is made once per walk. A named
 * unit's resolution, a conversion factor and the factor's `UnitComponent` are
 * kept by id ({@link once}). An element id read a second time is charged:
 * `Elements` is a SET, so a real unit never repeats one. So the free reads of
 * one walk parse each record at most twice (as a `Unit` and as a
 * `UnitComponent`), plus the top-level unit's own reads (at most three
 * records). Their bytes stay within twice the file size plus those three. A
 * nested unit is charged on every visit and never kept. A unit's SYMBOL
 * concatenates its elements' symbols, so a fan-out that a memo made cheap to
 * walk would still compose an output exponential in the depth. Bounding
 * charged reads bounds the elements composed.
 *
 * The depth cap, the budget and the memo apply to the parsed-source path only.
 * Every native (`readEntity`) caller already counts its reads and refuses with
 * its own "exceed the read limit" error (#7353), which this walk must not
 * pre-empt. That limit also bounds a native chain's depth. There the path set
 * alone refuses a cycle, as before #7547.
 *
 * A trip is sticky (`refused`). The top level then refuses the whole authored
 * unit, rather than hand back a symbol and scale composed of the elements the
 * walk happened to reach. A refused unit is reported the way any unit this
 * reader cannot resolve already is, so nothing throws. One difference from
 * Rust follows. `resolve_declared_unit` there skips every refused unit in the
 * project assignment. `extractProjectUnits` keeps one declared without a
 * scale when some of its elements composed, as its "incomplete" rule (#4833)
 * already does for a derived unit with an element it cannot read.
 */

import type { EntityRef } from './types.js';
import { composeDerived } from './project-units-symbols.js';

/** Max path length for one walk on the parsed-source path; `MAX_UNIT_RESOLVE_DEPTH` in Rust. */
const MAX_UNIT_RESOLVE_DEPTH = 16;

/**
 * Charged reads one walk may make; `MAX_UNIT_RESOLVE_DECODES` in Rust, which
 * charges every decode. A real derived unit is flat, so it is charged none.
 */
const MAX_UNIT_RESOLVE_READS = 256;

/**
 * Bytes the charged reads of one walk may parse between them. Without it, a
 * nested unit whose `Elements` list is long but holds no reference costs one
 * charge per visit, and a full parse each time. Rust has no such cap.
 */
const MAX_UNIT_RESOLVE_BYTES = 64 * 1024;

const NAMED_UNIT = ['IFCSIUNIT', 'IFCCONVERSIONBASEDUNIT', 'IFCCONVERSIONBASEDUNITWITHOFFSET', 'IFCCONTEXTDEPENDENTUNIT'];

/**
 * What IFC2X3, IFC4 and IFC4X3 allow at each place of a flat derived unit. That
 * is its elements and the `Unit` each names (`IfcNamedUnit`). For a
 * conversion-based unit it is also its `ConversionFactor` and that measure's
 * `UnitComponent` (`IfcUnit`). Inside the top-level unit, a read is free only
 * for these types.
 */
export const FLAT_UNIT = {
  element: new Set(['IFCDERIVEDUNITELEMENT']),
  unit: new Set(NAMED_UNIT),
  factor: new Set(['IFCMEASUREWITHUNIT']),
  factorUnit: new Set([...NAMED_UNIT, 'IFCDERIVEDUNIT', 'IFCMONETARYUNIT']),
} as const;

/** A place in a flat derived unit, as {@link FLAT_UNIT} names it. */
export type UnitPlace = keyof typeof FLAT_UNIT;

/** Bookkeeping for one top-level unit resolution. */
export interface UnitWalk {
  /** Unit ids on the current chain: a repeat is a cycle, the size the depth. */
  readonly path: Set<number>;
  /** Derived units on the current chain whose elements are being read. */
  derived: number;
  /** Entity reads charged so far. */
  reads: number;
  /** Bytes those charged reads parse. */
  bytes: number;
  /** A cycle, the depth cap or the read budget refused part of the walk. */
  refused: boolean;
  /** Whether the depth cap, the budget and the memo apply: the parsed-source path only (see above). */
  readonly budgeted: boolean;
  /** Free reads made inside the top-level unit, by place and id, and what each gave. */
  readonly memo: Partial<Record<UnitPlace, Map<number, unknown>>>;
}

export function newUnitWalk(budgeted: boolean): UnitWalk {
  return { path: new Set(), derived: 0, reads: 0, bytes: 0, refused: false, budgeted, memo: {} };
}

/** Put `ref` on the path; `false`, and the walk refused, for a cycle or, when budgeted, past the depth cap. */
export function enterUnit(walk: UnitWalk, ref: number): boolean {
  if (walk.path.has(ref) || (walk.budgeted && walk.path.size >= MAX_UNIT_RESOLVE_DEPTH)) {
    walk.refused = true;
    return false;
  }
  walk.path.add(ref);
  return true;
}

/** Whether reading `target` at `place` is a free read inside the top-level unit of a budgeted walk. */
function freeInTopUnit(walk: UnitWalk, target: EntityRef | undefined, place: UnitPlace): target is EntityRef {
  return walk.budgeted && walk.derived === 1 && target !== undefined && FLAT_UNIT[place].has(target.type.toUpperCase());
}

/** The walk's memo for `place`, made on first use. */
function memoOf(walk: UnitWalk, place: UnitPlace): Map<number, unknown> {
  return (walk.memo[place] ??= new Map());
}

/**
 * Call before reading `target`, the index entry of the entity about to be
 * read at `place`. Free: any read before the walk enters a derived unit (the
 * top-level unit and its own factor), and a dangling reference (nothing is
 * read). Free too, inside the top-level unit: a target whose type is allowed at
 * `place`. An element id read before in this walk is the one exception: it is charged.
 * Anything else is charged here, before the read. `false`, and the walk
 * refused, once the charged reads or their bytes pass the budget.
 */
export function chargeRead(walk: UnitWalk, target: EntityRef | undefined, place: UnitPlace): boolean {
  if (!walk.budgeted || target === undefined || walk.derived === 0) return true;
  if (freeInTopUnit(walk, target, place)) {
    if (place !== 'element') return true;
    const seen = memoOf(walk, place);
    if (!seen.has(target.expressId)) {
      seen.set(target.expressId, true);
      return true;
    }
  }
  walk.reads += 1;
  walk.bytes += target.byteLength;
  if (walk.reads <= MAX_UNIT_RESOLVE_READS && walk.bytes <= MAX_UNIT_RESOLVE_BYTES) return true;
  walk.refused = true;
  return false;
}

/**
 * `read()`, made once per id when it is a free read at `place` inside the
 * top-level unit: a later call returns what the first one gave. That covers
 * a named unit's resolution, a conversion factor and its `UnitComponent`.
 * Anywhere else, and on the native path, `read()` runs every time.
 */
export function once<T>(walk: UnitWalk, target: EntityRef | undefined, place: Exclude<UnitPlace, 'element'>, read: () => T): T {
  if (!freeInTopUnit(walk, target, place)) return read();
  const memo = memoOf(walk, place);
  if (memo.has(target.expressId)) return memo.get(target.expressId) as T;
  const value = read();
  memo.set(target.expressId, value);
  return value;
}

/** Go into a derived unit's elements. */
export function enterDerived(walk: UnitWalk): void {
  walk.derived += 1;
}

/** Leave the elements {@link enterDerived} went into. */
export function leaveDerived(walk: UnitWalk): void {
  walk.derived -= 1;
}

/**
 * {@link composeDerived}, or `undefined` when the symbol would pass the
 * engine's string limit. A flat unit is not charged, so its symbol grows with
 * its width times the length of the names it joins. `IfcLabel` has no length
 * limit in IFC2X3, so a small file can pass the limit: V8 throws
 * `RangeError: Invalid string length`. Any `RangeError` counts, whatever its
 * message, so the guard does not depend on the engine. Any other error is
 * thrown on.
 */
export function composeWithinLimit(parts: Array<[string, number]>): string | undefined {
  try {
    return composeDerived(parts);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}
