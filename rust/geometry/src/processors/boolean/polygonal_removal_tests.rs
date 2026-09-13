// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn tetra(origin: [f32; 3], size: f32) -> Mesh {
    let mut mesh = Mesh::new();
    for p in [[0.0, 0.0, 0.0], [size, 0.0, 0.0], [0.0, size, 0.0], [0.0, 0.0, size]] {
        mesh.positions.extend((0..3).map(|i| p[i] + origin[i]));
    }
    mesh.indices = vec![0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
    mesh
}

fn with_cavities(host: &Mesh, cavities: &[Mesh]) -> Mesh {
    let mut mesh = host.clone();
    for cavity in cavities {
        let offset = (mesh.positions.len() / 3) as u32;
        mesh.positions.extend_from_slice(&cavity.positions);
        for t in cavity.indices.chunks_exact(3) {
            mesh.indices.extend([offset + t[0], offset + t[2], offset + t[1]]);
        }
    }
    mesh
}

#[test]
fn issue_3925_interior_over_cut_is_rejected_even_when_bounds_are_unchanged() {
    for scale in [1.0 / 1024.0, 1.0, 1024.0] {
        let host = tetra([0.0; 3], 4.0 * scale);
        let a = tetra([0.5 * scale; 3], 0.25 * scale);
        let b = tetra([1.5 * scale, 0.5 * scale, 0.5 * scale], 0.25 * scale);
        let mut bound = RemovalBound::new(&host);
        bound.observe(&with_cavities(&host, std::slice::from_ref(&a)));
        bound.observe(&with_cavities(&host, std::slice::from_ref(&b)));
        let correct = with_cavities(&host, &[a, b]);
        let over_cut = with_cavities(&host, &[tetra([0.5 * scale; 3], 0.75 * scale)]);
        assert_eq!(host.bounds(), correct.bounds());
        assert_eq!(host.bounds(), over_cut.bounds());
        assert!(bound.allows(&correct), "two disjoint cavities attain the sum bound");
        assert!(!bound.allows(&over_cut), "an AABB check cannot see this larger internal cavity");
    }
}

#[test]
fn issue_3925_invalid_trial_cannot_authorize_a_moved_cutter() {
    let host = tetra([0.0; 3], 4.0);
    let mut bound = RemovalBound::new(&host);
    bound.observe(&tetra([0.0; 3], 5.0));
    // A later positive removal must not cancel the invalid growing trial and
    // turn its aggregate into permission to move a cutter.
    bound.observe(&tetra([0.0; 3], 1.0));
    assert!(!bound.allows(&host));
    assert!(!RemovalBound::new(&Mesh::new()).allows(&host));
}

/// An axis-aligned box as 12 outward triangles with per-triangle vertices.
fn far_box(lo: [f64; 3], hi: [f64; 3]) -> Mesh {
    let c = |x: usize, y: usize, z: usize| {
        [[lo[0], hi[0]][x] as f32, [lo[1], hi[1]][y] as f32, [lo[2], hi[2]][z] as f32]
    };
    let p = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
    let faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
    let mut mesh = Mesh::new();
    for f in faces {
        for t in [[f[0], f[1], f[2]], [f[0], f[2], f[3]]] {
            let base = (mesh.positions.len() / 3) as u32;
            for i in t {
                mesh.positions.extend_from_slice(&p[i]);
            }
            mesh.indices.extend([base, base + 1, base + 2]);
        }
    }
    mesh
}

fn joined(parts: &[&Mesh]) -> Mesh {
    let mut mesh = Mesh::new();
    for part in parts {
        let offset = (mesh.positions.len() / 3) as u32;
        mesh.positions.extend_from_slice(&part.positions);
        mesh.indices.extend(part.indices.iter().map(|i| offset + i));
    }
    mesh
}

/// A host 9 km out (native positions are absolute) that is OPEN: one unpaired
/// triangle inside the wall stands in for a crack, with normal -X. The trial
/// removes a 1 m rod sticking out of the wall's -X face, which moves the mesh's
/// bounding-box centre by 0.5 m.
///
/// The removed volume must read as the rod's volume. Summed about the world
/// origin the crack's flux (~3000 m³) flips the sign of both readings and the
/// removal reads negative; summed about each mesh's own centre the unchanged
/// crack leaves `(o_trial - o_host)·N/6` = -0.17 m³ in the difference, again
/// negative. Only one reference shared by host and trial cancels it (#4632).
#[test]
fn a_removal_over_an_open_far_host_reads_both_meshes_about_one_point_4632() {
    const F: [f64; 3] = [9000.375, 5000.25, 300.125];
    let at = |d: [f64; 3]| [F[0] + d[0], F[1] + d[1], F[2] + d[2]];
    let rod = far_box(at([-1.0, 0.0, 0.0]), at([0.0, 0.125, 0.125]));
    let wall = far_box(at([0.0, 0.0, 0.0]), at([3.0, 1.0, 3.0]));
    let short_wall = far_box(at([0.0, 0.0, 0.0]), at([2.5, 1.0, 3.0]));
    let mut crack = Mesh::new();
    for p in [at([1.5, 0.0, 0.5]), at([1.5, 0.0, 2.5]), at([1.5, 1.0, 0.5])] {
        crack.positions.extend(p.map(|x| x as f32));
    }
    crack.indices = vec![0, 1, 2];

    let host = joined(&[&rod, &wall, &crack]);
    let trial = joined(&[&wall, &crack]);
    let over_cut = joined(&[&short_wall, &crack]);

    let mut bound = RemovalBound::new(&host);
    bound.observe(&trial);
    assert!(
        bound.is_valid(),
        "removing a 0.0156 m³ rod from an open far host must read as a non-negative removal"
    );
    assert!(bound.allows(&trial), "the observed trial attains its own bound");
    assert!(!bound.allows(&over_cut), "a candidate that also removes 1.5 m³ of wall exceeds the bound");
}
