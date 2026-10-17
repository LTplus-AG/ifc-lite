// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Recovering an opening's oriented frame and box-ness from its face normals.

use super::cutter::OpeningFrame;
use super::geom::{extent_along_axis, mesh_point};
use super::NORMALIZE_EPSILON;
use crate::{Mesh, Point3, Vector3};

/// |cos| above which two facet normals share one cluster (about 11.5 degrees).
/// The merge tolerance of the frame inference, the box test and the wall-normal
/// vote, so the three agree on what counts as a single axis.
pub(super) const FACE_COS: f64 = 0.98;

/// One facet: its unit normal, an area-like weight and an anchor point.
pub(super) struct Facet {
    pub(super) normal: Vector3<f64>,
    pub(super) weight: f64,
    pub(super) anchor: Point3<f64>,
}

/// How a facet joins a cluster whose axis it matches.
#[derive(Clone, Copy)]
pub(super) enum Merge {
    /// The axis stays the first normal seen (the box test and the prism
    /// detector, which only ask WHICH cluster a facet is in).
    FirstSeen,
    /// The axis becomes the weight-averaged direction, flipped to the
    /// cluster's side (the frame inference and the wall-normal vote).
    Weighted,
}

/// The facets of `mesh` in index order: unit normal (`NORMALIZE_EPSILON`
/// floor), weight `|cross|` (twice the area) and first vertex. Triangles with
/// an out-of-range index or a degenerate normal are skipped.
pub(super) fn mesh_facets(mesh: &Mesh) -> impl Iterator<Item = Facet> + '_ {
    mesh.indices.chunks_exact(3).filter_map(|tri| {
        let (p0, p1, p2) = (
            mesh_point(mesh, tri[0])?,
            mesh_point(mesh, tri[1])?,
            mesh_point(mesh, tri[2])?,
        );
        let raw = (p1 - p0).cross(&(p2 - p0));
        let weight = raw.norm();
        let normal = raw.try_normalize(NORMALIZE_EPSILON)?;
        Some(Facet { normal, weight, anchor: p0 })
    })
}

/// Greedy first-fit clustering of facet normals, sign-free: a facet joins the
/// FIRST cluster whose axis has `|normal . axis| > cos_tol`, else it opens a new
/// one (ROUTER-9: this was four pasted loops).
///
/// `assigned(cluster, axis, anchor)` is called for every facet once it has a
/// cluster, with that cluster's axis as it stands. Returns `None` as soon as a
/// facet would open a cluster past `max_clusters` (`usize::MAX` for no cap), so
/// a curved mesh stops at the cap instead of clustering to the end.
pub(super) fn cluster_face_normals(
    facets: impl IntoIterator<Item = Facet>,
    cos_tol: f64,
    merge: Merge,
    max_clusters: usize,
    mut assigned: impl FnMut(usize, &Vector3<f64>, Point3<f64>),
) -> Option<Vec<(Vector3<f64>, f64)>> {
    let mut clusters: Vec<(Vector3<f64>, f64)> = Vec::new();
    for Facet { mut normal, weight, anchor } in facets {
        let hit = clusters
            .iter()
            .position(|(axis, _)| normal.dot(axis).abs() > cos_tol);
        let index = match hit {
            Some(index) => {
                if let Merge::Weighted = merge {
                    let (axis, axis_weight) = &mut clusters[index];
                    if normal.dot(axis) < 0.0 {
                        normal = -normal;
                    }
                    if let Some(merged) =
                        (*axis * *axis_weight + normal * weight).try_normalize(NORMALIZE_EPSILON)
                    {
                        *axis = merged;
                        *axis_weight += weight;
                    }
                }
                index
            }
            None => {
                if clusters.len() >= max_clusters {
                    return None;
                }
                clusters.push((normal, weight));
                clusters.len() - 1
            }
        };
        assigned(index, &clusters[index].0, anchor);
    }
    Some(clusters)
}

/// Whether a mesh is a clean axis-aligned (in its own frame) rectangular box —
/// i.e. exactly 6 planar faces forming a bounding parallelepiped. Curved or
/// arched openings produce many distinct triangle normals; rectilinear but
/// non-rectangular openings (e.g. an L-shaped shaft) share the same three axes
/// as a box but split their faces across more than two parallel planes per
/// axis. Both cases must go through full CSG rather than the AABB cutters.
///
/// Matches the anti-parallel merge tolerance used by `infer_opening_frame` so
/// the two helpers agree on what counts as a single axis.
pub(super) fn is_rectangular_box_mesh(mesh: &Mesh) -> bool {
    let mut tri_axes: Vec<(usize, f64)> = Vec::with_capacity(mesh.indices.len() / 3);
    // At most three axes: a fourth is already not a box. The signed offset
    // along the merged axis is taken against the first normal seen for that
    // cluster, so opposite faces produce offsets of opposite sign.
    let Some(clusters) = cluster_face_normals(
        mesh_facets(mesh),
        FACE_COS,
        Merge::FirstSeen,
        3,
        |index, axis, anchor| tri_axes.push((index, anchor.coords.dot(axis))),
    ) else {
        return false;
    };
    let axes: Vec<Vector3<f64>> = clusters.into_iter().map(|(axis, _)| axis).collect();
    if axes.len() != 3 {
        return false;
    }

    // The 3 distinct face normals must be mutually orthogonal — otherwise a
    // shape like a trapezoid extrusion (front/back + top/bottom + two slanted
    // sides whose normals are anti-parallel and merge into one axis) would
    // pass with 3 "axes" but not actually be a box. A trapezoid's slanted
    // axis is not perpendicular to the top/bottom axis. Tolerance 0.02 rad
    // matches the 0.98 dot tolerance used above for anti-parallel merging.
    const ORTHOGONAL_DOT_TOL: f64 = 0.02;
    for i in 0..3 {
        for j in (i + 1)..3 {
            if axes[i].dot(&axes[j]).abs() > ORTHOGONAL_DOT_TOL {
                return false;
            }
        }
    }

    // For each axis, the triangle offsets must cluster around exactly 2 values
    // (the two opposite faces of the box). More than 2 distinct planes means
    // the footprint is rectilinear-but-not-rectangular (e.g. an L-shape).
    // Tolerance is 1mm absolute — coarser than float precision but tight
    // enough to distinguish wall positions in any realistic IFC unit.
    const PLANE_TOL: f64 = 1e-3;
    for axis_index in 0..3 {
        let mut planes: Vec<f64> = Vec::with_capacity(3);
        for (idx, offset) in &tri_axes {
            if *idx != axis_index {
                continue;
            }
            if !planes.iter().any(|p| (p - offset).abs() < PLANE_TOL) {
                planes.push(*offset);
                if planes.len() > 2 {
                    return false;
                }
            }
        }
        if planes.len() != 2 {
            return false;
        }
    }
    true
}

pub(super) fn infer_opening_frame(mesh: &Mesh, extrusion_dir: Option<&Vector3<f64>>) -> Option<OpeningFrame> {
    let axes = cluster_face_normals(
        mesh_facets(mesh),
        FACE_COS,
        Merge::Weighted,
        usize::MAX,
        |_, _, _| {},
    )?;

    if axes.len() < 3 {
        return extrusion_dir.and_then(|dir| OpeningFrame::from_depth(*dir));
    }

    let depth_index =
        if let Some(dir) = extrusion_dir.and_then(|d| d.try_normalize(NORMALIZE_EPSILON)) {
            axes.iter()
                .enumerate()
                .max_by(|(_, (a, _)), (_, (b, _))| a.dot(&dir).abs().total_cmp(&b.dot(&dir).abs()))
                .map(|(index, _)| index)?
        } else {
            axes.iter()
                .enumerate()
                .filter_map(|(index, (axis, _))| extent_along_axis(mesh, axis).map(|e| (index, e)))
                .min_by(|(_, a), (_, b)| a.total_cmp(b))
                .map(|(index, _)| index)?
        };

    let mut depth = axes[depth_index].0;
    if let Some(dir) = extrusion_dir {
        if depth.dot(dir) < 0.0 {
            depth = -depth;
        }
    }

    let mut cross_candidates: Vec<Vector3<f64>> = axes
        .iter()
        .enumerate()
        .filter_map(|(index, (axis, _))| {
            (index != depth_index && axis.dot(&depth).abs() < 0.25).then_some(*axis)
        })
        .collect();

    if cross_candidates.len() < 2 {
        let mut frame = OpeningFrame::from_depth(depth)?;
        frame.depth_is_authored = extrusion_dir.is_some();
        return Some(frame);
    }

    let mut cross_a = cross_candidates.remove(0);
    cross_a = (cross_a - depth * cross_a.dot(&depth)).try_normalize(NORMALIZE_EPSILON)?;
    let mut cross_b = depth.cross(&cross_a).try_normalize(NORMALIZE_EPSILON)?;
    if cross_b.dot(&cross_candidates[0]) < 0.0 {
        cross_b = -cross_b;
    }

    Some(OpeningFrame {
        depth,
        cross_a,
        cross_b,
        depth_is_authored: extrusion_dir.is_some(),
    })
}


#[cfg(test)]
#[path = "opening_frame_tests.rs"]
mod tests;
