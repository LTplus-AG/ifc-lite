// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! How far a host face may sit from a cutter cap and still be on it.
//!
//! Three rules ask whether a cap ends ON a host face or short of it: the prism
//! cap extension, the exit-cap probe, and the recess test of the rectangle
//! paths. The first two allowed about a millimetre, so a recess ending within
//! a millimetre of the far face was read as reaching it and pushed through.
//! The recess test erred the other way: its tolerance was under what rounding
//! to the grid moves a face, so a recess starting on a face read as floating
//! inside the host, and was extended through the far face as well.
//!
//! The two bounds here are steps of the kernel grid, floored at f32 noise:
//! what rounding can move a face, and no more. The extension and the probe use
//! [`flush_band_at`], the widest gap that is still flush; wider, and they take
//! a skin the author left. The recess test uses the smaller
//! [`recess_face_tol`], because the same tolerance decides that an opening
//! starts inside the host, and wider there turns an interior opening into a
//! recess.

use crate::csg::plane_eps::PlaneEps;
use crate::kernel::mesh_bridge::SNAP_GRID;
use crate::{Point3, Vector3};

/// A host face up to this far beyond a cap lies on the cap. Four grid steps,
/// 61 um in metres. Rounding moves a vertex up to 0.87 of a step along an
/// oblique axis, so host and cutter together move under two steps; the other
/// two are margin.
const FLUSH_BAND: f64 = 4.0 * SNAP_GRID;

/// [`FLUSH_BAND`] where coordinates reach `mag`: never narrower than f32
/// storage resolves there. The floor passes the band beyond about 150 m, so
/// far from the origin a thinner skin is again read as flush.
pub(super) fn flush_band_at(mag: f64) -> f64 {
    FLUSH_BAND.max(mag * 4.0e-7)
}

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
/// opening 11 um inside an axis-aligned 1 m wall is still interior
/// (`reveal_tests`). Off the axes the bound grows to 13 um.
pub(super) fn recess_face_tol(bounds: &[Point3<f64>], dir: &Vector3<f64>, wall_proj_extent: f64) -> f64 {
    PlaneEps::from_points(bounds, wall_proj_extent * 1e-5)
        .for_normal(dir)
        .max(grid_rounding_along(dir))
}
