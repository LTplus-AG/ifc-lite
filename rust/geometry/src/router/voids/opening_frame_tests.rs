// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// The weighted clustering loop `infer_opening_frame` and
/// `dominant_horizontal_normal` each carried (ROUTER-9), as the oracle.
fn legacy_weighted(mesh: &Mesh, keep: impl Fn(&Vector3<f64>) -> bool) -> Vec<(Vector3<f64>, f64)> {
    let mut axes: Vec<(Vector3<f64>, f64)> = Vec::new();
    for tri in mesh.indices.chunks_exact(3) {
        let (Some(p0), Some(p1), Some(p2)) = (
            mesh_point(mesh, tri[0]),
            mesh_point(mesh, tri[1]),
            mesh_point(mesh, tri[2]),
        ) else {
            continue;
        };
        let normal_raw = (p1 - p0).cross(&(p2 - p0));
        let weight = normal_raw.norm();
        let Some(mut normal) = normal_raw.try_normalize(NORMALIZE_EPSILON) else {
            continue;
        };
        if !keep(&normal) {
            continue;
        }
        if let Some((axis, axis_weight)) = axes
            .iter_mut()
            .find(|(axis, _)| normal.dot(axis).abs() > 0.98)
        {
            if normal.dot(axis) < 0.0 {
                normal = -normal;
            }
            if let Some(merged) =
                (*axis * *axis_weight + normal * weight).try_normalize(NORMALIZE_EPSILON)
            {
                *axis = merged;
                *axis_weight += weight;
            }
        } else {
            axes.push((normal, weight));
        }
    }
    axes
}

/// The first-seen loop `is_rectangular_box_mesh` carried, as the oracle:
/// the axes and each triangle's (cluster, offset), or `None` past three axes.
fn legacy_first_seen(mesh: &Mesh) -> Option<(Vec<Vector3<f64>>, Vec<(usize, f64)>)> {
    let mut axes: Vec<Vector3<f64>> = Vec::new();
    let mut tri_axes = Vec::new();
    for tri in mesh.indices.chunks_exact(3) {
        let (Some(p0), Some(p1), Some(p2)) = (
            mesh_point(mesh, tri[0]),
            mesh_point(mesh, tri[1]),
            mesh_point(mesh, tri[2]),
        ) else {
            continue;
        };
        let Some(normal) = (p1 - p0).cross(&(p2 - p0)).try_normalize(NORMALIZE_EPSILON) else {
            continue;
        };
        let index = match axes.iter().position(|axis| normal.dot(axis).abs() > 0.98) {
            Some(index) => index,
            None => {
                if axes.len() >= 3 {
                    return None;
                }
                axes.push(normal);
                axes.len() - 1
            }
        };
        tri_axes.push((index, p0.coords.dot(&axes[index])));
    }
    Some((axes, tri_axes))
}

struct Stream(u64);
impl Stream {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 11) as f64 / (1u64 << 53) as f64 * 4.0 - 2.0) as f32
    }
}

/// Triangle soups from three families: arbitrary, near-planar facets that merge
/// into few clusters, and an axis-aligned box.
fn corpus() -> Vec<Mesh> {
    let mut s = Stream(0xD1B5_4A32_D192_ED03);
    let mut meshes = Vec::new();
    for case in 0..300usize {
        let mut m = Mesh::default();
        let tris = 1 + case % 40;
        for t in 0..tris {
            let base = match case % 3 {
                0 => [s.next(), s.next(), s.next()],
                1 => [s.next(), s.next(), (t % 3) as f32],
                _ => [0.0, 0.0, 0.0],
            };
            for _ in 0..3 {
                let jitter = if case % 3 == 1 { 0.002 } else { 1.0 };
                m.positions.extend_from_slice(&[
                    base[0] + s.next() * jitter,
                    base[1] + s.next() * jitter,
                    base[2] + s.next() * jitter * 0.01,
                ]);
                m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            let i = (t * 3) as u32;
            m.indices.extend_from_slice(&[i, i + 1, i + 2]);
        }
        meshes.push(m);
    }
    meshes.push(crate::GeometryRouter::make_box_mesh(
        crate::Point3::new(0.0, 0.0, 0.0),
        crate::Point3::new(2.0, 0.3, 1.0),
    ));
    meshes
}

#[test]
fn weighted_clusters_match_the_loops_they_replaced() {
    for (i, mesh) in corpus().iter().enumerate() {
        let new = cluster_face_normals(mesh_facets(mesh), FACE_COS, Merge::Weighted, usize::MAX, |_, _, _| {})
            .expect("uncapped");
        let old = legacy_weighted(mesh, |_| true);
        assert_eq!(new.len(), old.len(), "mesh {i}");
        for (n, o) in new.iter().zip(&old) {
            assert_eq!(n.1.to_bits(), o.1.to_bits(), "mesh {i} weight");
            assert_eq!(
                [n.0.x.to_bits(), n.0.y.to_bits(), n.0.z.to_bits()],
                [o.0.x.to_bits(), o.0.y.to_bits(), o.0.z.to_bits()],
                "mesh {i} axis"
            );
        }
        // The wall-normal vote's horizontal filter.
        let new = cluster_face_normals(
            mesh_facets(mesh).filter(|f| !(f.normal.z.abs() > 0.2)),
            FACE_COS,
            Merge::Weighted,
            usize::MAX,
            |_, _, _| {},
        )
        .expect("uncapped");
        let old = legacy_weighted(mesh, |n| !(n.z.abs() > 0.2));
        assert_eq!(new.len(), old.len(), "mesh {i} horizontal");
    }
}

#[test]
fn first_seen_clusters_match_the_box_loop_including_the_cap() {
    let mut capped = 0;
    for (i, mesh) in corpus().iter().enumerate() {
        let mut tri_axes = Vec::new();
        let new = cluster_face_normals(mesh_facets(mesh), 0.98, Merge::FirstSeen, 3, |idx, axis, anchor| {
            tri_axes.push((idx, anchor.coords.dot(axis)));
        });
        match (new, legacy_first_seen(mesh)) {
            (None, None) => capped += 1,
            (Some(new), Some((axes, old_tri_axes))) => {
                assert_eq!(new.len(), axes.len(), "mesh {i}");
                assert_eq!(tri_axes.len(), old_tri_axes.len(), "mesh {i}");
                for (a, b) in tri_axes.iter().zip(&old_tri_axes) {
                    assert_eq!(a.0, b.0, "mesh {i} cluster");
                    assert_eq!(a.1.to_bits(), b.1.to_bits(), "mesh {i} offset");
                }
            }
            (new, old) => panic!("mesh {i}: cap disagrees ({} vs {})", new.is_some(), old.is_some()),
        }
    }
    assert!(capped > 10, "the sweep must reach the cap ({capped})");
}

#[test]
fn a_clean_box_is_a_box_and_an_empty_mesh_is_not() {
    let boxed = crate::GeometryRouter::make_box_mesh(
        crate::Point3::new(0.0, 0.0, 0.0),
        crate::Point3::new(2.0, 0.3, 1.0),
    );
    assert!(is_rectangular_box_mesh(&boxed));
    assert!(!is_rectangular_box_mesh(&Mesh::default()));
}
