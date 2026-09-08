// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The `JsValue`-free core of [`super::space_plate`]: the build/edit entry
//! points' input decoding, option resolution, and the `EditError` ->
//! stable-code table.
//!
//! Not everything that decodes a wire buffer for space-plate lives here.
//! `add_face` still decodes its own coords inline in `space_plate.rs`, inside
//! the `#[wasm_bindgen]` method, and is untested. Moving it is a separate
//! change; this doc says so rather than letting the module name imply a
//! coverage it does not have.
//!
//! Split out of `space_plate.rs` because extracting these for direct testing
//! pushed that file past the 400-line module-size ratchet. The ratchet's rule
//! is split, never add an allowlist row, so this is the split. (No line count
//! is quoted here on purpose: it would be stale by the next commit.)
//! Everything here is plain Rust that runs on the native test target; the
//! `#[wasm_bindgen]` entry points stay next door as thin wrappers.

use ifc_lite_geometry::space_dcel::{BuildOptions, EditError, InputSegment};

#[cfg(test)]
#[path = "space_plate_tests.rs"]
mod tests;

/// Hard DoS ceiling on arrangement input size. The T-junction resolve is ~O(n^2)
/// after the per-sweep-splits fix; these bounds keep even adversarial input to a
/// few seconds while sitting far above any real floor plan (hundreds of walls).
const MAX_INPUT_SEGMENTS: usize = 16384;
const MAX_INPUT_RECTS: usize = 4096;

/// Resolve `(snap_tolerance, min_area)` against [`BuildOptions::default`]: a
/// value `<= 0` (including exactly `0`) takes the default, any positive value
/// is used as-is. No `JsValue` on this path, so it's directly testable.
pub(crate) fn resolve_build_options(snap_tolerance: f64, min_area: f64) -> BuildOptions {
    let defaults = BuildOptions::default();
    BuildOptions {
        snap_tolerance: if snap_tolerance > 0.0 { snap_tolerance } else { defaults.snap_tolerance },
        min_area: if min_area > 0.0 { min_area } else { defaults.min_area },
    }
}

/// Pure core of [`SpacePlateHandle::new`]: validate the flat wire arrays and
/// build the `InputSegment` list. `segCoords` is stride 4 (`ax, ay, bx, by`
/// per segment); `segSources[i] < 0` means no source element; a present
/// `segHalfThickness[i]` is floored at `0.0` (a negative wire value is
/// treated as centreline-only, not subtracted). Callable — and testable —
/// without `JsValue`; the `#[wasm_bindgen(constructor)]` wrapper maps the
/// `String` error to one.
pub(crate) fn build_segments(
    seg_coords: &[f64],
    seg_sources: &[i32],
    seg_half_thickness: &[f64],
) -> Result<Vec<InputSegment>, String> {
    if !seg_coords.len().is_multiple_of(4) {
        return Err("segCoords length must be a multiple of 4 (ax, ay, bx, by per segment)".to_string());
    }
    let n = seg_coords.len() / 4;
    if n > MAX_INPUT_SEGMENTS {
        return Err("too many wall segments for the space-plate arrangement".to_string());
    }
    if seg_sources.len() != n {
        return Err("segSources length must equal the segment count (segCoords.len / 4)".to_string());
    }
    if !seg_half_thickness.is_empty() && seg_half_thickness.len() != n {
        return Err("segHalfThickness must be empty or have one entry per segment".to_string());
    }
    Ok((0..n)
        .map(|i| {
            let o = i * 4;
            let src = seg_sources[i];
            let half = seg_half_thickness.get(i).copied().unwrap_or(0.0);
            InputSegment::new(
                [seg_coords[o], seg_coords[o + 1]],
                [seg_coords[o + 2], seg_coords[o + 3]],
                if src < 0 { None } else { Some(src as u32) },
            )
            .with_half_thickness(half.max(0.0))
        })
        .collect())
}

/// Pure core of [`SpacePlateHandle::from_wall_rects`]: validate the flat
/// `rectCoords` wire array (stride 8: 4 CCW corners × x,y per wall) and
/// build the per-wall corner arrays.
pub(crate) fn build_wall_rects(rect_coords: &[f64]) -> Result<Vec<[[f64; 2]; 4]>, String> {
    if !rect_coords.len().is_multiple_of(8) {
        return Err("rectCoords length must be a multiple of 8 (4 corners × x,y per wall)".to_string());
    }
    // Count from the wire length and refuse BEFORE collecting. Checking
    // `rects.len()` after `.collect()` returns the same error for the same
    // inputs; the only difference is that the rejected allocation never
    // happens. At the ceiling that allocation is ~262 KB, so this is
    // consistency with `build_segments` above (which already derives `n` from
    // the length and checks first), not a meaningful DoS win.
    if rect_coords.len() / 8 > MAX_INPUT_RECTS {
        return Err("too many wall rects for the space-plate arrangement".to_string());
    }
    Ok(rect_coords
        .chunks_exact(8)
        .map(|c| [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]])
        .collect())
}

/// Pure core of [`edit_err`]: the `EditError` variant's stable code (matches
/// `EditErrorCode` in `space-edit-error.ts`) and human-readable message.
pub(crate) fn edit_error_parts(e: EditError) -> (&'static str, &'static str) {
    match e {
        EditError::StaleHandle => ("StaleHandle", "this element no longer exists (it was removed or merged)"),
        EditError::VerticesNotOnFace => ("VerticesNotOnFace", "both split points must lie on the same room"),
        EditError::DegenerateCut => ("DegenerateCut", "the two points are the same or already share a wall"),
        EditError::BordersExterior => ("BordersExterior", "this wall is the room's outer edge — removing it would open the room"),
        EditError::BridgeEdge => ("BridgeEdge", "this wall bridges the room to itself"),
        EditError::VertexNotDissolvable => ("VertexNotDissolvable", "this node joins three or more walls"),
        EditError::InvalidPolygon => ("InvalidPolygon", "a room needs a simple ring of 3+ points enclosing real area"),
    }
}
