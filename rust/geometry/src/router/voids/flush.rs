// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! How far a host face may sit from a cutter cap and still be on it.
//!
//! Three rules ask whether a cap ends ON a host face or short of it: the prism
//! cap extension, the recess test of the rectangle paths, and the exit-cap
//! probe. Each used to allow about a millimetre, so a recess ending within a
//! millimetre of the far face was read as reaching it and pushed through. An
//! 11 mm recess in a 12 mm finish layer lost its 1 mm skin that way, through
//! whichever of the three ran.
//!
//! They share the bounds below, which are steps of the kernel grid: what
//! rounding to the grid and f32 storage can move a face, and no more. Host
//! material deeper than that behind a cap is a skin the author left.

use crate::csg::plane_eps::PlaneEps;
use crate::kernel::mesh_bridge::SNAP_GRID;
use crate::{Point3, Vector3};

/// A host face up to this far beyond a cap lies on the cap. Four grid steps,
/// 61 um in metres: two roundings (host and cutter) with a step to spare.
pub(super) const FLUSH_BAND: f64 = 4.0 * SNAP_GRID;

/// The most that rounding a vertex to the kernel grid moves it along the unit
/// `dir`: half a step on each axis.
fn grid_rounding_along(dir: &Vector3<f64>) -> f64 {
    0.5 * SNAP_GRID * (dir.x.abs() + dir.y.abs() + dir.z.abs())
}

/// Face-alignment tolerance of the RECESS check (#853) along the unit `dir`.
///
/// The relative `wall_proj_extent * 1e-5` pad keeps a tiny float-error offset
/// from masking a flush face. The bounds are read back from f32-stored
/// vertices, so at building scale a flush face can also sit a few ULPs off
/// (4.3 um at 51 m, above the 2.5 um pad of a 250 mm wall, #7920). The pad is
/// therefore floored at that f32 noise, projected onto `dir` as in
/// [`PlaneEps::for_normal`], so a coordinate perpendicular to the extrusion
/// cannot widen it.
///
/// It is floored at grid rounding too. The host bounds come from a mesh the
/// facet weld has put on the kernel grid, the opening's from the file: a
/// 12 mm sheet's face read 5.8 um off the recess that starts on it, past a
/// 4 um tolerance, so the recess was taken for an opening floating inside the
/// sheet and extended through its far face. Half a step, not a whole one: an
/// opening 11 um inside a 1 m wall is still interior (`reveal_tests`).
pub(super) fn recess_face_tol(bounds: &[Point3<f64>], dir: &Vector3<f64>, wall_proj_extent: f64) -> f64 {
    PlaneEps::from_points(bounds, wall_proj_extent * 1e-5)
        .for_normal(dir)
        .max(grid_rounding_along(dir))
}
