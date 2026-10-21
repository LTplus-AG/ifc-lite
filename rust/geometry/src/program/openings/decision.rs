// SPDX-License-Identifier: MPL-2.0
//! Geometry-only classification of already admitted occurrence probes.
use crate::program::opening::OpeningBounds;
use crate::router::voids::geom::{infer_opening_frame, is_axis_aligned_direction, is_rectangular_box_mesh};
use crate::router::voids::OpeningType;
use crate::router::{ClassificationKind, OpeningKindDiag};
use crate::{Mesh, Point3, Vector3};

/// WORLD bounds: a cutter may sit in its own per-element local frame (wasm),
/// so its origin is folded back in; `apply_void_context` relativizes these by
/// the host origin alongside the cutter mesh (#1310 review).
pub(super) fn world_bounds(mesh: &Mesh) -> (Point3<f64>, Point3<f64>) {
    let o = mesh.origin;
    let (min, max) = mesh.bounds();
    (
        Point3::new(min.x as f64 + o[0], min.y as f64 + o[1], min.z as f64 + o[2]),
        Point3::new(max.x as f64 + o[0], max.y as f64 + o[1], max.z as f64 + o[2]),
    )
}

pub(super) fn kind(opening: &OpeningType) -> (ClassificationKind, OpeningKindDiag) {
    match opening {
        OpeningType::Rectangular(..) => {
            (ClassificationKind::Rectangular, OpeningKindDiag::Rectangular)
        }
        OpeningType::DiagonalRectangular(..) => {
            (ClassificationKind::Diagonal, OpeningKindDiag::Diagonal)
        }
        OpeningType::NonRectangular(..) => {
            (ClassificationKind::NonRectangular, OpeningKindDiag::NonRectangular)
        }
    }
}

type ItemBounds = (Point3<f64>, Point3<f64>, Option<Vector3<f64>>);

/// Decide and publish one cutter at a time, so the classification effects of
/// earlier cutters keep their original order if a later predicate unwinds.
pub(crate) struct Decisions(Inputs);
enum Inputs {
    Parts(std::collections::vec_deque::IntoIter<Mesh>),
    Bounds(std::vec::IntoIter<ItemBounds>),
    Meshes(std::iter::Zip<std::vec::IntoIter<ItemBounds>, std::vec::IntoIter<Mesh>>),
}

/// Per-item geometry-driven classification when both probes agree on the item
/// count, per-item boxes when they do not, and per-part boxes when no item
/// bounds were recovered at all.
pub(super) fn classify(
    parts: std::collections::VecDeque<Mesh>,
    bounds: OpeningBounds,
    meshes: Vec<Mesh>,
) -> Decisions {
    Decisions(if bounds.is_empty() {
        Inputs::Parts(parts.into_iter())
    } else if meshes.len() != bounds.len() {
        Inputs::Bounds(bounds.into_iter())
    } else {
        Inputs::Meshes(bounds.into_iter().zip(meshes))
    })
}

impl Iterator for Decisions {
    type Item = OpeningType;
    fn next(&mut self) -> Option<Self::Item> {
        match &mut self.0 {
            Inputs::Parts(parts) => parts.next().map(|mesh| {
                let (min, max) = world_bounds(&mesh);
                OpeningType::Rectangular(min, max, None)
            }),
            Inputs::Bounds(bounds) => {
                bounds.next().map(|(min, max, dir)| OpeningType::Rectangular(min, max, dir))
            }
            Inputs::Meshes(meshes) => {
                meshes.next().map(|((min, max, dir), mesh)| classify_item(min, max, dir, mesh))
            }
        }
    }
}

/// The frame-based DiagonalRectangular path handles tilted rectangular
/// openings, including rotated-footprint floor openings, so NonRectangular is
/// reserved for genuinely curved or arched voids.
fn classify_item(
    min: Point3<f64>,
    max: Point3<f64>,
    dir: Option<Vector3<f64>>,
    mesh: Mesh,
) -> OpeningType {
    let frame = infer_opening_frame(&mesh, dir.as_ref());
    let diagonal = dir.map(|d| !is_axis_aligned_direction(&d)).unwrap_or(false);
    let clean_box = is_rectangular_box_mesh(&mesh);
    if let Some(frame) = frame {
        if !clean_box {
            OpeningType::NonRectangular(mesh, min, max, dir)
        } else if diagonal || !frame.is_axis_aligned() {
            OpeningType::DiagonalRectangular(mesh, frame)
        } else {
            OpeningType::Rectangular(min, max, dir)
        }
    } else if clean_box {
        OpeningType::Rectangular(min, max, dir)
    } else {
        OpeningType::NonRectangular(mesh, min, max, dir)
    }
}
