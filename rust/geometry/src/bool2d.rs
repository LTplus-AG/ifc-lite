// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 2D Boolean Operations for Profile-Level Void Subtraction
//!
//! This module provides efficient 2D polygon boolean operations using the i_overlay crate.
//! It is used to subtract void footprints from profiles before extrusion, which is much
//! more efficient and reliable than performing 3D CSG operations on finished geometry.

use crate::error::{Error, Result};
use crate::profile::Profile2D;
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use nalgebra::Point2;

/// Epsilon for floating point comparisons in 2D operations
#[cfg(test)]
const EPSILON_2D: f64 = 1e-9;

/// Minimum area threshold - polygons smaller than this are considered degenerate
const MIN_AREA_THRESHOLD: f64 = 1e-10;

/// Perform 2D boolean difference: profile - void_contour
///
/// Takes a profile and subtracts a void contour from it, returning a new profile
/// with the void added as a hole (or modifying the outer boundary if the void
/// cuts through it).
///
/// # Arguments
/// * `profile` - The base profile to subtract from
/// * `void_contour` - The void footprint to subtract (should be counter-clockwise)
///
/// # Returns
/// * `Ok(Profile2D)` - The resulting profile with the void subtracted
/// * `Err` - If the operation fails
pub fn subtract_2d(profile: &Profile2D, void_contour: &[Point2<f64>]) -> Result<Profile2D> {
    if void_contour.len() < 3 {
        return Err(Error::InvalidProfile(
            "Void contour must have at least 3 vertices".to_string(),
        ));
    }

    if profile.outer.len() < 3 {
        return Err(Error::InvalidProfile(
            "Profile must have at least 3 vertices".to_string(),
        ));
    }

    // Convert profile to i_overlay format
    // Subject is the profile (outer boundary + holes)
    let subject = profile_to_paths(profile);

    // Clip is the void contour
    let clip = vec![contour_to_path(void_contour)];

    // Perform boolean difference using i_overlay
    // Result is Vec<Vec<Vec<[f64; 2]>>> - Vec of shapes, each shape is Vec of contours
    let result = subject.overlay(&clip, OverlayRule::Difference, FillRule::EvenOdd);

    // Convert result back to Profile2D (take first shape if multiple)
    shapes_to_profile(&result)
}

/// Perform 2D boolean difference with multiple voids at once
///
/// More efficient than calling subtract_2d multiple times as it performs
/// a single boolean operation.
///
/// # Arguments
/// * `profile` - The base profile to subtract from
/// * `void_contours` - List of void footprints to subtract
///
/// # Returns
/// * `Ok(Profile2D)` - The resulting profile with all voids subtracted
pub fn subtract_multiple_2d(
    profile: &Profile2D,
    void_contours: &[Vec<Point2<f64>>],
) -> Result<Profile2D> {
    if void_contours.is_empty() {
        return Ok(profile.clone());
    }

    // Filter out invalid contours
    let valid_contours: Vec<_> = void_contours.iter().filter(|c| c.len() >= 3).collect();

    if valid_contours.is_empty() {
        return Ok(profile.clone());
    }

    // Convert profile to i_overlay format
    let subject = profile_to_paths(profile);

    // Convert all void contours - union them first if multiple
    let clip: Vec<Vec<[f64; 2]>> = valid_contours.iter().map(|c| contour_to_path(c)).collect();

    // Perform boolean difference
    let result = subject.overlay(&clip, OverlayRule::Difference, FillRule::EvenOdd);

    // Convert result back to Profile2D
    shapes_to_profile(&result)
}

/// Like [`subtract_multiple_2d`], but also reports how many DISCONNECTED output
/// shapes the difference produced (each with non-degenerate area). The returned
/// `Profile2D` is the largest shape (as [`subtract_multiple_2d`]); a caller that
/// must not silently drop geometry — the 2D opening-subtraction re-extrude —
/// checks `shapes == 1` and otherwise defers to the exact kernel (a void that
/// splits the profile into pieces can't be re-extruded from a single profile).
pub fn subtract_multiple_2d_counted(
    profile: &Profile2D,
    void_contours: &[Vec<Point2<f64>>],
) -> Result<(Profile2D, usize)> {
    let valid_contours: Vec<_> = void_contours.iter().filter(|c| c.len() >= 3).collect();
    if valid_contours.is_empty() {
        return Ok((profile.clone(), 1));
    }
    let subject = profile_to_paths(profile);
    let clip: Vec<Vec<[f64; 2]>> = valid_contours.iter().map(|c| contour_to_path(c)).collect();
    let result = subject.overlay(&clip, OverlayRule::Difference, FillRule::EvenOdd);
    // Count EVERY non-empty output shape (any outer contour with >= 3 vertices),
    // NOT just those above MIN_AREA_THRESHOLD. This gate decides single-vs-multi
    // shape for the caller: only `shapes == 1` lets the re-extrude proceed with the
    // largest shape. Filtering by area would let a valid-but-tiny disconnected
    // sliver report `shapes == 1`, and its geometry would be silently dropped; the
    // conservative count forces the exact-kernel fallback whenever the difference
    // splits the profile at all, even into a sub-threshold piece.
    let shapes = result
        .iter()
        .filter(|s| s.first().is_some_and(|outer| outer.len() >= 3))
        .count();
    Ok((shapes_to_profile(&result)?, shapes))
}

/// Check if a contour is valid (has area, not degenerate)
pub fn is_valid_contour(contour: &[Point2<f64>]) -> bool {
    if contour.len() < 3 {
        return false;
    }

    let area = compute_signed_area(contour).abs();
    area > MIN_AREA_THRESHOLD
}

/// Compute the signed area of a 2D contour
/// Positive = counter-clockwise, Negative = clockwise
pub fn compute_signed_area(contour: &[Point2<f64>]) -> f64 {
    if contour.len() < 3 {
        return 0.0;
    }

    let mut area = 0.0;
    let n = contour.len();

    for i in 0..n {
        let j = (i + 1) % n;
        area += contour[i].x * contour[j].y;
        area -= contour[j].x * contour[i].y;
    }

    area * 0.5
}

/// Ensure contour has counter-clockwise winding (positive area)
pub fn ensure_ccw(contour: &[Point2<f64>]) -> Vec<Point2<f64>> {
    let area = compute_signed_area(contour);
    if area < 0.0 {
        // Clockwise - reverse to make counter-clockwise
        contour.iter().rev().cloned().collect()
    } else {
        contour.to_vec()
    }
}

/// Ensure contour has clockwise winding (for holes)
pub fn ensure_cw(contour: &[Point2<f64>]) -> Vec<Point2<f64>> {
    let area = compute_signed_area(contour);
    if area > 0.0 {
        // Counter-clockwise - reverse to make clockwise
        contour.iter().rev().cloned().collect()
    } else {
        contour.to_vec()
    }
}

/// Check if a point is inside a contour using ray casting
pub fn point_in_contour(point: &Point2<f64>, contour: &[Point2<f64>]) -> bool {
    if contour.len() < 3 {
        return false;
    }

    let mut inside = false;
    let n = contour.len();

    let mut j = n - 1;
    for i in 0..n {
        let pi = &contour[i];
        let pj = &contour[j];

        if ((pi.y > point.y) != (pj.y > point.y))
            && (point.x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y) + pi.x)
        {
            inside = !inside;
        }
        j = i;
    }

    inside
}

// `contour_inside_contour` and `contour_bounds` were deleted here: the C3.2
// `pub(crate)` narrowing orphaned them (zero callers, production or test), so
// per the anti-cruft rule they go rather than gain a dead-code allow.
//
// `simplify_contour`, `union_contours`, and `bounds_overlap` were deleted here
// for the same reason (D15 dead-code sweep): each had zero production callers,
// only their own now-deleted unit tests.

// ============================================================================
// Internal Helper Functions
// ============================================================================

/// Convert Profile2D to i_overlay path format
fn profile_to_paths(profile: &Profile2D) -> Vec<Vec<[f64; 2]>> {
    let mut paths = Vec::with_capacity(1 + profile.holes.len());

    // Add outer boundary (must be counter-clockwise for i_overlay)
    let outer = ensure_ccw(&profile.outer);
    paths.push(contour_to_path(&outer));

    // Add holes (must be clockwise for i_overlay, but we'll use EvenOdd fill rule)
    for hole in &profile.holes {
        let hole_cw = ensure_cw(hole);
        paths.push(contour_to_path(&hole_cw));
    }

    paths
}

/// Convert a Point2 contour to i_overlay path format
fn contour_to_path(contour: &[Point2<f64>]) -> Vec<[f64; 2]> {
    contour.iter().map(|p| [p.x, p.y]).collect()
}

/// Convert i_overlay result shapes back to Profile2D
///
/// i_overlay returns Vec<Vec<Vec<[f64; 2]>>> where:
/// - Outer Vec: list of shapes
/// - Middle Vec: list of contours per shape (first is outer, rest are holes)
/// - Inner Vec: list of points per contour
fn shapes_to_profile(shapes: &[Vec<Vec<[f64; 2]>>]) -> Result<Profile2D> {
    if shapes.is_empty() {
        return Err(Error::InvalidProfile(
            "Boolean operation resulted in empty geometry".to_string(),
        ));
    }

    // Find the largest shape by outer boundary area
    let mut best_shape_idx = 0;
    let mut largest_area = 0.0f64;

    for (idx, shape) in shapes.iter().enumerate() {
        if shape.is_empty() {
            continue;
        }
        // First contour in shape is the outer boundary
        let outer_contour: Vec<Point2<f64>> =
            shape[0].iter().map(|p| Point2::new(p[0], p[1])).collect();
        let area = compute_signed_area(&outer_contour).abs();
        if area > largest_area {
            largest_area = area;
            best_shape_idx = idx;
        }
    }

    let best_shape = &shapes[best_shape_idx];
    if best_shape.is_empty() {
        return Err(Error::InvalidProfile(
            "Selected shape has no contours".to_string(),
        ));
    }

    // First contour is outer boundary
    let outer: Vec<Point2<f64>> = best_shape[0]
        .iter()
        .map(|p| Point2::new(p[0], p[1]))
        .collect();
    let outer = ensure_ccw(&outer);

    // Rest are holes
    let mut holes = Vec::new();
    for contour in best_shape.iter().skip(1) {
        let hole: Vec<Point2<f64>> = contour.iter().map(|p| Point2::new(p[0], p[1])).collect();

        if is_valid_contour(&hole) {
            holes.push(ensure_cw(&hole));
        }
    }

    Ok(Profile2D { outer, holes })
}

#[cfg(test)]
#[path = "bool2d_tests.rs"]
mod tests;
