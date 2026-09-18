// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The exit-cap far-field cutoff, split out of `exit_cap.rs` (module-size
//! ratchet) so its rationale can stay fully written out.

use crate::Mesh;

/// The exit-cap far-field cutoff (metres): deliberately NOT
/// `ifc_lite_core::LARGE_COORD_THRESHOLD_METERS`.
///
/// Until #4934 this site shared that constant (#4611 unified it with
/// `coord_is_large` after a `>=`-vs-`>` mismatch). #4934 lowered the SHARED
/// constant from 10 km to 1 km for an unrelated reason (closing the f32
/// re-basing gap on 1-10 km survey-grid sites); following it here would wrongly
/// move a noise floor that is a property of f32 magnitude alone, validated
/// empirically around 9 km (`issue_4611_far_field_threshold`,
/// `synthesis_tests.rs`), not of wherever the RTC line sits. A model whose
/// sampled median stays near the origin but carries a valid host 1-10 km
/// away (multi-building/corridor layout, or any direct router/mesher caller
/// skipping the orchestrator rebase per `rust/AGENTS.md`) is NOT re-based, so
/// moving this cutoff down with the RTC gate would make that host skip the
/// occupancy probe and treat a pre-cut jamb as an exit.
pub(in crate::router::voids) const EXIT_CAP_FAR_FIELD_THRESHOLD_METERS: f64 = 10_000.0;

/// True when any stored vertex coordinate of `host` is past
/// [`EXIT_CAP_FAR_FIELD_THRESHOLD_METERS`], strictly, any axis, absolute
/// value — `coord_is_large`'s comparison shape, kept local so the cutoff can
/// differ in VALUE without differing in FORM. `chunks(3)` pads a ragged tail.
pub(in crate::router::voids) fn any_vertex_is_large(host: &Mesh) -> bool {
    let at = |c: &[f32], i: usize| c.get(i).copied().unwrap_or(0.0) as f64;
    host.positions
        .chunks(3)
        .any(|c| [0, 1, 2].map(|i| at(c, i)).iter().any(|v| v.abs() > EXIT_CAP_FAR_FIELD_THRESHOLD_METERS))
}
