// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Finiteness guard for [`super::output_cap::SymbolicAccumulator`]'s
//! `push_*` methods.
//!
//! Split out of `output_cap.rs` rather than added inline: that file sits at
//! its 400-line ratchet ceiling, and four new guards push it over.
//!
//! `parse_axis2_placement_2d` and `parse_cartesian_transformation_operator`
//! deliberately do NOT refuse a non-finite ambient placement themselves --
//! routing to `Transform2D::unresolved()` would set `tx = ty = 0.0`, which is
//! finite, and would stop every `tx`/`ty`-keyed guard downstream from firing.
//! So the design is that every CONSUMER of a resolved placement guards
//! itself. `push_circle` already did; the other four `push_*` methods on
//! `SymbolicAccumulator` trusted their caller to have done so already.
//! Because the accumulator's `data` field is private and reachable only
//! through `push_*`, putting the guard here makes it impossible to bypass
//! rather than merely conventional.
//!
//! ONLY tx/ty-derived coordinate fields are checked: `points`, `x`/`y`,
//! `center_x`/`center_y`, `endpoints`. `push_circle` already checked its own
//! `center_x`/`center_y`/`radius` before this change; it now goes through
//! this same helper. The NaN-sentinel fields in `primitives.rs` -- every
//! field marked `#[serde(with = "nan_as_null")]` (`world_y` on `SymbolicPolyline`,
//! `SymbolicCircle`, `SymbolicText`, `SymbolicFillArea`, `SymbolicGridAxis`,
//! plus `SymbolicFillArea::hatch_angle_secondary`) -- mean "unresolved" ON
//! PURPOSE via `f32::NAN` and must NOT be rejected here: doing so would
//! destroy the "unresolved elevation" convention `nan_as_null` exists to
//! carry.

/// True if every coordinate in `coords` is finite.
///
/// One shared chokepoint rather than four near-duplicates, for the same
/// reason `SymbolicAccumulator::try_push` gives all five `push_*` one shared
/// accept/refuse decision: `try_push`'s own doc notes that keeping a check in
/// five copies is how `push_text` once came to omit a field from its byte
/// charge, and a validity check invites the identical drift.
pub(super) fn all_finite(coords: &[f32]) -> bool {
    coords.iter().all(|c| c.is_finite())
}
