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
