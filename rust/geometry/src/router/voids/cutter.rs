// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The classified shape of one opening, and the one place it is projected.
//!
//! [`CutterKind`] is the classification `classify_openings` produces (three
//! variants, payloads unchanged). [`Cutter`] is the uniform read of one kind:
//! its mesh, its bounds, its penetration direction and its oriented frame.
//! Before this module each consumer re-derived those from a `match` of its own
//! (seven projections, ROUTER-32), and the copies had already drifted on
//! whether a diagonal cutter's bounds fold in the mesh origin.

use super::geom::is_axis_aligned_direction;
use super::malformed_opening_repair::translate_cutter_mesh;
use super::NORMALIZE_EPSILON;
use crate::{Mesh, Point3, Vector3};

/// Classification of an opening for void subtraction.
#[derive(Clone)]
pub(super) enum CutterKind {
    /// Rectangular opening with AABB clipping
    /// Fields: (min_bounds, max_bounds, extrusion_direction)
    Rectangular(Point3<f64>, Point3<f64>, Option<Vector3<f64>>),
    /// Diagonal rectangular opening with mesh geometry and a full oriented frame.
    /// The frame preserves roof-window roll, not just the penetration direction.
    DiagonalRectangular(Mesh, OpeningFrame),
    /// Non-rectangular opening (circular, arched, or floor openings with
    /// rotated footprint). Uses full CSG subtraction with the actual mesh
    /// geometry. The AABB + extrusion direction are kept so that callers can
    /// fall back to a rectangular box cut when CSG can't run (issue #635 —
    /// e.g. circular windows whose triangulated profile blows past
    /// `MAX_CSG_POLYGONS_PER_MESH`).
    NonRectangular(Mesh, Point3<f64>, Point3<f64>, Option<Vector3<f64>>),
}

/// World-space basis for an oriented rectangular opening.
#[derive(Clone, Copy)]
pub(super) struct OpeningFrame {
    pub(super) depth: Vector3<f64>,
    pub(super) cross_a: Vector3<f64>,
    pub(super) cross_b: Vector3<f64>,
    pub(super) depth_is_authored: bool,
}

impl OpeningFrame {
    pub(super) fn from_depth(depth: Vector3<f64>) -> Option<Self> {
        let depth = depth.try_normalize(NORMALIZE_EPSILON)?;
        let seed = if depth.z.abs() < 0.9 {
            Vector3::new(0.0, 0.0, 1.0)
        } else {
            Vector3::new(0.0, 1.0, 0.0)
        };
        let cross_a = seed.cross(&depth).try_normalize(NORMALIZE_EPSILON)?;
        let cross_b = depth.cross(&cross_a).try_normalize(NORMALIZE_EPSILON)?;
        Some(Self {
            depth,
            cross_a,
            cross_b,
            depth_is_authored: true,
        })
    }

    pub(super) fn is_axis_aligned(&self) -> bool {
        is_axis_aligned_direction(&self.depth)
            && is_axis_aligned_direction(&self.cross_a)
            && is_axis_aligned_direction(&self.cross_b)
    }
}

/// A uniform, borrowed read of one [`CutterKind`].
#[derive(Clone, Copy)]
pub(super) struct Cutter<'a> {
    kind: &'a CutterKind,
}

impl CutterKind {
    /// The uniform read of this kind.
    pub(super) fn cutter(&self) -> Cutter<'_> {
        Cutter { kind: self }
    }

    /// Return a copy translated by `-origin` (world → host-local frame). Bounds
    /// (`Point3`) shift; direction vectors and the oriented `OpeningFrame` are
    /// translation-invariant and pass through unchanged.
    pub(super) fn translated(&self, origin: [f64; 3]) -> CutterKind {
        let sub = |p: &Point3<f64>| Point3::new(p.x - origin[0], p.y - origin[1], p.z - origin[2]);
        match self {
            CutterKind::Rectangular(min, max, dir) => {
                CutterKind::Rectangular(sub(min), sub(max), *dir)
            }
            CutterKind::DiagonalRectangular(mesh, frame) => {
                CutterKind::DiagonalRectangular(translate_cutter_mesh(mesh, origin), *frame)
            }
            CutterKind::NonRectangular(mesh, min, max, dir) => {
                CutterKind::NonRectangular(translate_cutter_mesh(mesh, origin), sub(min), sub(max), *dir)
            }
        }
    }
}

impl<'a> Cutter<'a> {
    /// The cutter mesh. `None` for `Rectangular`, which has no mesh until it is
    /// synthesised.
    pub(super) fn mesh(&self) -> Option<&'a Mesh> {
        match self.kind {
            CutterKind::Rectangular(..) => None,
            CutterKind::DiagonalRectangular(m, _) | CutterKind::NonRectangular(m, ..) => Some(m),
        }
    }

    /// The penetration direction the classification recorded, whether or not
    /// it was authored.
    pub(super) fn depth(&self) -> Option<Vector3<f64>> {
        match self.kind {
            CutterKind::DiagonalRectangular(_, f) => Some(f.depth),
            CutterKind::NonRectangular(_, _, _, d) | CutterKind::Rectangular(_, _, d) => *d,
        }
    }

    /// The penetration direction only when the opening AUTHORED one: a
    /// diagonal cutter whose frame was inferred from its box carries none.
    pub(super) fn authored_depth(&self) -> Option<Vector3<f64>> {
        match self.kind {
            CutterKind::DiagonalRectangular(_, f) if f.depth_is_authored => Some(f.depth),
            CutterKind::DiagonalRectangular(..) => None,
            CutterKind::NonRectangular(_, _, _, d) | CutterKind::Rectangular(_, _, d) => *d,
        }
    }

    /// The mesh and its penetration direction, for the two mesh-carrying kinds.
    pub(super) fn mesh_cutter(&self) -> Option<(&'a Mesh, Option<Vector3<f64>>)> {
        self.mesh().map(|m| (m, self.depth()))
    }

    /// Bounds in the cutter's own frame: the payload of `Rectangular` and
    /// `NonRectangular`, the mesh bounds (origin NOT folded) of a diagonal one.
    pub(super) fn bounds(&self) -> (Point3<f64>, Point3<f64>) {
        match self.kind {
            CutterKind::Rectangular(lo, hi, _) | CutterKind::NonRectangular(_, lo, hi, _) => {
                (*lo, *hi)
            }
            CutterKind::DiagonalRectangular(m, _) => mesh_bounds_f64(m),
        }
    }

    /// World-space bounds: [`Self::bounds`], with a diagonal cutter's mesh
    /// origin folded back in (`world = origin + position`).
    pub(super) fn world_bounds(&self) -> (Point3<f64>, Point3<f64>) {
        match self.kind {
            CutterKind::DiagonalRectangular(m, _) => {
                let (lo, hi) = mesh_bounds_f64(m);
                let o = m.origin;
                (
                    Point3::new(lo.x + o[0], lo.y + o[1], lo.z + o[2]),
                    Point3::new(hi.x + o[0], hi.y + o[1], hi.z + o[2]),
                )
            }
            _ => self.bounds(),
        }
    }

    /// The mesh, its bounds and its direction, normalised across the two
    /// exact-subtract variants. A diagonal cutter is a REAL solid and is
    /// subtracted exactly, never approximated by a frame-rotated AABB; its
    /// mesh bounds and frame depth seed the #635 fallback like a
    /// non-rectangular opening's payload does. `None` for `Rectangular`.
    pub(super) fn normalized(
        &self,
    ) -> Option<(&'a Mesh, Point3<f64>, Point3<f64>, Option<Vector3<f64>>)> {
        let mesh = self.mesh()?;
        let (lo, hi) = self.bounds();
        Some((mesh, lo, hi, self.depth()))
    }
}

/// `Mesh::bounds`, widened to f64.
fn mesh_bounds_f64(mesh: &Mesh) -> (Point3<f64>, Point3<f64>) {
    let (lo, hi) = mesh.bounds();
    (
        Point3::new(lo.x as f64, lo.y as f64, lo.z as f64),
        Point3::new(hi.x as f64, hi.y as f64, hi.z as f64),
    )
}
