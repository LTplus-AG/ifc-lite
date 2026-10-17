// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Untextured void-output hygiene: preserve an existing exact closed boundary.
use crate::{exact_topology::strict_closed_mesh, Mesh};

pub(super) fn clean_void_output(mesh: &mut Mesh) {
    if !mesh.needs_degenerate_cleanup() {
        return;
    }
    // Preserve every represented closed boundary. Closure after cleanup alone
    // cannot detect deletion of an entire disconnected subgrid component.
    // This incidence certificate is not a simplicity proof; empty, non-finite,
    // degenerate and already-open sources still get ordinary cleanup.
    if strict_closed_mesh(mesh) {
        return;
    }
    mesh.clean_degenerate_watertight();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::{arrangement::box_mesh, mesh_bridge::tris_to_mesh};

    #[test]
    fn issue_7292_void_hygiene_preserves_a_separate_closed_subgrid_component() {
        let edge = crate::kernel::mesh_bridge::SNAP_GRID / 4.;
        let mut mesh = tris_to_mesh(&box_mesh([0.; 3], [1.; 3]));
        mesh.merge(&tris_to_mesh(&box_mesh([2., 0., 0.], [2. + edge, edge, edge])));
        assert!(strict_closed_mesh(&mesh));
        assert_eq!(mesh.triangle_count(), 24);
        let original = mesh.clone();
        let mut plain = mesh.clone();
        plain.clean_degenerate_watertight();
        assert!(strict_closed_mesh(&plain));
        assert_eq!(plain.triangle_count(), 12, "closure alone misses a lost component");

        clean_void_output(&mut mesh);
        assert_eq!(mesh.indices, original.indices, "both closed boundaries must survive");
        assert_eq!(mesh.positions, original.positions);
        assert_eq!(mesh.normals, original.normals);
    }

    #[test]
    fn issue_7292_void_hygiene_cannot_open_a_positive_closed_subgrid_layer() {
        let mut mesh = tris_to_mesh(&box_mesh([0.; 3], [1., 1., 1. / 262144.]));
        assert!(strict_closed_mesh(&mesh));
        let mut plain = mesh.clone();
        plain.clean_degenerate();
        assert!(
            !strict_closed_mesh(&plain),
            "index-only dropping opens this real layer"
        );
        clean_void_output(&mut mesh);
        assert!(strict_closed_mesh(&mesh));
        assert_eq!(
            mesh.triangle_count(),
            12,
            "all six finite layer faces remain represented"
        );
    }

    #[test]
    fn issue_7292_void_hygiene_still_drops_an_unsupported_open_flap() {
        let mut mesh = Mesh::new();
        mesh.positions = vec![0., 0., 0., 1., 0., 0., 0., 1., 0., 0.5, 5e-6, 0.];
        mesh.indices = vec![0, 1, 2, 0, 1, 3];
        assert!(!strict_closed_mesh(&mesh));
        clean_void_output(&mut mesh);
        assert_eq!(
            mesh.indices,
            vec![0, 1, 2],
            "an open source gets ordinary subgrid cleanup"
        );
    }
}
