// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::Mesh;

fn prism(profile: &[(f32, f32)], z0: f32, z1: f32) -> Mesh {
    let mut mesh = Mesh::new();
    for &z in &[z0, z1] {
        for &(x, y) in profile {
            mesh.positions.extend_from_slice(&[x, y, z]);
            mesh.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
    }
    let n = profile.len() as u32;
    for i in 1..n - 1 {
        mesh.indices.extend_from_slice(&[0, i + 1, i]);
        mesh.indices.extend_from_slice(&[n, n + i, n + i + 1]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        mesh.indices
            .extend_from_slice(&[i, j, n + j, i, n + j, n + i]);
    }
    mesh
}

fn rotate(mesh: &Mesh, angle: f64, tx: f64, ty: f64) -> Mesh {
    let (s, c) = angle.sin_cos();
    let mut out = mesh.clone();
    for p in out.positions.chunks_exact_mut(3) {
        let (x, y) = (p[0] as f64, p[1] as f64);
        p[0] = (c * x - s * y + tx) as f32;
        p[1] = (s * x + c * y + ty) as f32;
    }
    out
}

#[test]
fn plan_rotated_mitred_wall_tip_strip_is_closed_3977() {
    let angle = 3.0_f64.to_radians();
    let host = rotate(
        &prism(
            &[(0.0, -0.05), (4.0, -0.05), (3.85, 0.05), (0.0, 0.05)],
            0.0,
            3.0,
        ),
        angle,
        0.0,
        0.0,
    );
    // A 13 mm strip has one face on the long wall face, crosses the mitred
    // corner, and is flush with both vertical caps. In the world frame this
    // exact configuration returned 147 triangles with unmatched edges.
    let cutter = rotate(
        &prism(
            &[(3.987, -0.05), (4.0, -0.05), (4.0, 0.1), (3.987, 0.1)],
            0.0,
            3.0,
        ),
        angle,
        0.0,
        0.0,
    );
    let (s, c) = angle.sin_cos();
    let frame = OpeningFrame {
        depth: Vector3::new(0.0, 0.0, 1.0),
        cross_a: Vector3::new(c, s, 0.0),
        cross_b: Vector3::new(-s, c, 0.0),
        depth_is_authored: true,
    };
    let openings = vec![OpeningType::DiagonalRectangular(cutter, frame)];
    assert!(
        vertical_depth_wall_frame(&host, &openings).is_some(),
        "the authored vertical cutter and thin, tall host must qualify"
    );
    let mut inferred = openings.clone();
    let OpeningType::DiagonalRectangular(_, inferred_frame) = &mut inferred[0] else {
        unreachable!()
    };
    inferred_frame.depth_is_authored = false;
    assert!(
        vertical_depth_wall_frame(&host, &inferred).is_none(),
        "an inferred vertical direction must not opt a host into the new path"
    );
    let host_volume = mesh_signed_volume(&host).abs();
    let ctx = VoidContext {
        merged_openings: openings.clone(),
        openings,
        param: None,
        bool2d: None,
    };
    let bounds = world_host_bounds(&host);
    let out = GeometryRouter::new().apply_void_context_inner(host, &ctx, 3977, bounds, true);
    assert!(
        mesh_is_closed_exact(&out),
        "wall-local cut must close the rotated mitred-tip strip ({} tris)",
        out.triangle_count()
    );
    assert!(
        mesh_signed_volume(&out).abs() < host_volume - 1.0e-5,
        "the closed result must retain the actual tip cut"
    );
}
