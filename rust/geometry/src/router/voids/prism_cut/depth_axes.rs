// SPDX-License-Identifier: MPL-2.0
//! Candidate prism axes retain first-seen facet order and the original cap.
use super::V3;
use super::super::opening_frame::{cluster_face_normals, Facet, Merge};
use nalgebra::{Point3, Vector3};

pub(super) fn cluster(normals: &[Option<V3>]) -> Option<Vec<V3>> {
    // More than 65 distinct directions is way past any stepped extrusion:
    // bail early.
    let facets = normals.iter().flatten().map(|n| Facet {
        normal: Vector3::new(n[0], n[1], n[2]),
        weight: 0.0,
        anchor: Point3::origin(),
    });
    let clusters: Vec<V3> =
        cluster_face_normals(facets, 0.999, Merge::FirstSeen, 65, |_, _, _| {})?
            .into_iter()
            .map(|(axis, _)| [axis.x, axis.y, axis.z])
            .collect();
    Some(clusters)
}
