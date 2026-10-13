/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bound on one unit resolution in `project-units.ts` (#ISSUE): the
 * TypeScript twin of `UnitWalk` in `rust/core/src/project_units/mod.rs`
 * (#4603), with the same two limits.
 *
 * `IfcDerivedUnit -> IfcDerivedUnitElement -> Unit` is a walk over
 * file-supplied references. The schema types that `Unit` as an `IfcNamedUnit`,
 * so a real derived unit nests one level, but the reader follows whatever the
 * file names. Before #ISSUE only the native read path carried a path set, and
 * the parsed-source path had no bound at all: a derived unit that names itself
 * threw `RangeError: Maximum call stack size exceeded`, so did a long acyclic
 * chain, and an acyclic fan-out ran for seconds and composed a symbol
 * exponential in its depth. AGENTS.md "Bounding walks over file-supplied
 * references" names the three mechanisms; each one here closes one of them:
 *
 * - `path` (insert on the way in, remove on the way out): a repeat is a cycle.
 * - `MAX_UNIT_RESOLVE_DEPTH`: one path's length, so the stack stays bounded
 *   while the path set never fires on an acyclic chain.
 * - `MAX_UNIT_RESOLVE_READS`: the entity reads of the whole walk, which bounds
 *   an acyclic fan-out that neither of the others sees. It applies to the
 *   parsed-source path only: every native (`readEntity`) caller already counts
 *   its reads and refuses with its own "exceed the read limit" error (#7353),
 *   which this budget must not pre-empt.
 *
 * Not a memo, as in Rust: a unit's SYMBOL concatenates its elements' symbols,
 * so a fan-out that a memo made cheap to walk would still compose an output
 * exponential in the depth. Bounding reads bounds the elements composed.
 *
 * A trip is sticky (`refused`): the top level then refuses the whole authored
 * unit, rather than hand back a symbol and scale composed of the elements the
 * walk happened to reach. A refused unit is reported the way any unit this
 * reader cannot resolve already is, so nothing throws. One difference from
 * Rust follows: `resolve_declared_unit` there skips every refused unit in the
 * project assignment, while `extractProjectUnits` keeps one declared without a
 * scale when some of its elements composed, as its "incomplete" rule (#4833)
 * already does for a derived unit with an element it cannot read.
 */

/** Max path length for one walk; `MAX_UNIT_RESOLVE_DEPTH` in Rust. */
const MAX_UNIT_RESOLVE_DEPTH = 16;

/**
 * Entity reads one walk may spend; `MAX_UNIT_RESOLVE_DECODES` in Rust. A real
 * derived unit (`m³/s`, `W/(m·K)`, over a conversion-based unit) reads under
 * thirty entities.
 */
const MAX_UNIT_RESOLVE_READS = 256;

/** Bookkeeping for one top-level unit resolution. */
export interface UnitWalk {
  /** Unit ids on the current chain: a repeat is a cycle, the size the depth. */
  readonly path: Set<number>;
  /** Entity reads spent so far. */
  reads: number;
  /** A cycle, the depth cap or the read budget refused part of the walk. */
  refused: boolean;
  /** Whether the read budget applies: the parsed-source path only (see above). */
  readonly budgeted: boolean;
}

export function newUnitWalk(budgeted: boolean): UnitWalk {
  return { path: new Set(), reads: 0, refused: false, budgeted };
}

/** Put `ref` on the path; `false`, and the walk refused, for a cycle or past the depth cap. */
export function enterUnit(walk: UnitWalk, ref: number): boolean {
  if (walk.path.has(ref) || walk.path.size >= MAX_UNIT_RESOLVE_DEPTH) {
    walk.refused = true;
    return false;
  }
  walk.path.add(ref);
  return true;
}

/** Charge one entity read; `false`, and the walk refused, once the budget is spent. */
export function chargeRead(walk: UnitWalk): boolean {
  if (!walk.budgeted) return true;
  walk.reads += 1;
  if (walk.reads <= MAX_UNIT_RESOLVE_READS) return true;
  walk.refused = true;
  return false;
}
