// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7292: independently check the diagnostic on real unresolved intersections.

use super::{intersection_solid, DegenerateReason, IntersectionSolid, Mesh};
use crate::clash_contact_axes::gate_axes;
use crate::kernel::{arrangement::Tri, budget, mesh_bridge::intersection_tris};

#[path = "../tests/support/clash_box_fixtures.rs"]
mod clash_box_fixtures;
use clash_box_fixtures::{rotated_box_mesh, ROT_Z_3_4_5, TESSELLATIONS};

fn projection(p: [f64; 3], axis: [f64; 3]) -> f64 {
    p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2]
}

// Pairwise adjacency + graph traversal, independently of production union-find.
fn bit_connected_components(tris: &[Tri]) -> Vec<Vec<usize>> {
    let mut visited = vec![false; tris.len()];
    let mut groups = Vec::new();
    for seed in 0..tris.len() {
        if visited[seed] {
            continue;
        }
        visited[seed] = true;
        let mut pending = vec![seed];
        let mut group = Vec::new();
        while let Some(i) = pending.pop() {
            group.push(i);
            for (j, candidate) in tris.iter().enumerate() {
                if !visited[j]
                    && tris[i].iter().any(|a| {
                        candidate
                            .iter()
                            .any(|b| a.map(f64::to_bits) == b.map(f64::to_bits))
                    })
                {
                    visited[j] = true;
                    pending.push(j);
                }
            }
        }
        group.sort_unstable();
        groups.push(group);
    }
    groups
}

fn assert_fixture_face_axes(mesh: &Mesh, n: usize, axes: &[[f64; 3]]) {
    // The first triangle of each original box face is regular. Derive its
    // direction directly from the actual f32 fixture, not the ideal rotation.
    let vertex = |i: u32| {
        let o = i as usize * 3;
        [
            mesh.positions[o] as f64,
            mesh.positions[o + 1] as f64,
            mesh.positions[o + 2] as f64,
        ]
    };
    for face in 0..6 {
        let o = face * 2 * n * n * 3;
        let [a, b, c] = [
            vertex(mesh.indices[o]),
            vertex(mesh.indices[o + 1]),
            vertex(mesh.indices[o + 2]),
        ];
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let cross = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let length = projection(cross, cross).sqrt();
        assert!(length.is_finite() && length > 0.0);
        let normal = cross.map(|x| x / length);
        // Existing gate_axes direction-family contract (ORTHO_EPS), not a new
        // geometry-acceptance tolerance. Opposite normals represent one axis.
        assert!(
            axes.iter()
                .any(|axis| projection(normal, *axis).abs() > 1.0 - 1.0e-4),
            "actual fixture face {face} has no candidate axis"
        );
    }
}

fn reference_report(tris: &[Tri], axes: &[[f64; 3]], a: &Mesh, b: &Mesh) -> (f64, f64) {
    let extents: [f64; 3] = std::array::from_fn(|k| {
        a.positions
            .chunks_exact(3)
            .chain(b.positions.chunks_exact(3))
            .map(|p| (p[k] as f64).abs())
            .fold(0.0, f64::max)
    });
    let mut expected: Option<(f64, f64)> = None;
    for group in bit_connected_components(tris) {
        for &axis in axes {
            let mut values: Vec<f64> = group
                .iter()
                .flat_map(|&i| tris[i].iter().map(|&p| projection(p, axis)))
                .collect();
            assert!(values.iter().all(|x| x.is_finite()));
            values.sort_by(f64::total_cmp);
            let width = values[values.len() - 1] - values[0];
            // Fixed existing four-band rule, independently from the gate's
            // NearBand instance. required belongs to this component's axis.
            let projected = (axis[0].abs() * extents[0]
                + axis[1].abs() * extents[1]
                + axis[2].abs() * extents[2])
                * (1.0 / 4194304.0);
            let floor = 8.0 / 65536.0;
            let required = 4.0 * (projected * projected).max(floor * floor).sqrt();
            if width < required && expected.is_none_or(|(prior, _)| width < prior) {
                expected = Some((width, required));
            }
        }
    }
    expected.expect("real sub-band arrangement must have a violating component")
}

#[test]
fn issue_7292_rotated_clash_reports_actual_thinnest_violating_component() {
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    for cells in [1u32, 2, 4, 6, 8] {
        let depth = cells as f64 / 65536.0;
        for n in TESSELLATIONS {
            let _element = budget::enter_element();
            let a = rotated_box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], n, ROT_Z_3_4_5);
            let b = rotated_box_mesh([1.0 - depth, 0.0, 0.0], [2.0, 1.0, 1.0], n, ROT_Z_3_4_5);
            // Separate deterministic original solves on the same actual input;
            // this does not claim inspection of the public call's private buffer.
            let tris = intersection_tris(&a, &b);
            assert!(
                !tris.is_empty(),
                "{cells} cells n={n}: raw intersection missing"
            );
            let axes = gate_axes(&a, &b);
            assert_fixture_face_axes(&a, n, &axes);
            assert_fixture_face_axes(&b, n, &axes);
            let expected = reference_report(&tris, &axes, &a, &b);
            match intersection_solid(&a, &b) {
                IntersectionSolid::Degenerate(DegenerateReason::BelowKernelResolution {
                    thickness_m,
                    required_m,
                }) => {
                    assert_eq!(
                        thickness_m.to_bits(),
                        expected.0.to_bits(),
                        "{cells} cells n={n}: report must measure an actual component"
                    );
                    assert_eq!(
                        required_m.to_bits(),
                        expected.1.to_bits(),
                        "{cells} cells n={n}: required band must belong to that axis"
                    );
                }
                other => {
                    panic!("{cells} cells n={n}: real unresolved pair must be withheld: {other:?}")
                }
            }
        }
    }
}
