// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7633: an approximate plane bucket must not fit disconnected patches to
//! each other's f32 normal errors. Tests use actual finite source walls and
//! distinguish full-edge adjacency from a mere point contact.

use super::{snap_grid, weld_near_coplanar_facets};
use crate::Mesh;

type Point = [f64; 3];

fn triangles(tris: &[[Point; 3]]) -> Mesh {
    let mut mesh = Mesh::new();
    for tri in tris {
        for p in tri {
            mesh.indices.push(mesh.vertex_count() as u32);
            mesh.positions.extend(p.map(|v| v as f32));
            mesh.normals.extend([0., 0., 1.]);
        }
    }
    mesh
}

fn quad(p: [Point; 4], alternate: bool) -> [[Point; 3]; 2] {
    if alternate {
        [[p[0], p[1], p[3]], [p[1], p[2], p[3]]]
    } else {
        [[p[0], p[1], p[2]], [p[0], p[2], p[3]]]
    }
}

fn source_grid(mesh: &Mesh) -> Vec<f32> {
    mesh.positions
        .iter()
        .map(|&v| snap_grid(f64::from(v)) as f32)
        .collect()
}

/// These two wall segments came from the same authored plane, but their
/// independent f32 endpoints yield different normals. The old global fit
/// moves the remote corner by ~80 micrometres. Each finite patch is already
/// exactly planar and has no local facet jitter to correct.
#[test]
fn issue_7633_remote_planar_wall_patches_retain_source_corners() {
    let wall = |a: [f64; 2], b: [f64; 2]| {
        [
            [a[0], a[1], 3.65],
            [b[0], b[1], 3.65],
            [b[0], b[1], 3.9],
            [a[0], a[1], 3.9],
        ]
    };
    let a = wall(
        [17.515506744384766, 43.07204818725586],
        [17.441171646118164, 43.31073760986328],
    );
    let b = wall(
        [24.324649810791016, 21.207794189453125],
        [24.25031280517578, 21.44648551940918],
    );
    for alternate in [false, true] {
        for reverse in [false, true] {
            let mut tris = Vec::from(quad(a, alternate));
            tris.extend(quad(b, alternate));
            if reverse {
                tris.reverse();
            }
            let source = triangles(&tris);
            let result = weld_near_coplanar_facets(&source);
            assert_eq!(result.indices, source.indices);
            assert_eq!(
                result.positions,
                source_grid(&source),
                "a distant fitted normal must not move an already-planar patch"
            );
        }
    }
}

/// Two independent planes can meet at one corner and still share the coarse
/// normal/offset bucket. Joining their fits through that point would move a
/// different corner of the flat patch by two kernel grid steps.
#[test]
fn issue_7633_point_touching_patches_do_not_share_a_fit() {
    let g = 1. / 65536.;
    let a = [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]];
    let b = [
        [0., 0., 0.],
        [-1., 0., 0.],
        [-1., -1., 4. * g],
        [0., -1., 4. * g],
    ];
    let mut tris = Vec::from(quad(a, false));
    tris.extend(quad(b, false));
    let source = triangles(&tris);
    let result = weld_near_coplanar_facets(&source);
    assert_eq!(result.positions, source_grid(&source));
}

/// A singleton component gets no fit and therefore no position rewrite,
/// including the existing rule that an unwelded cell stays bit-exact (#4698).
#[test]
fn issue_7633_point_touching_single_facets_keep_unsnapped_positions() {
    let source = triangles(&[
        [[0., 0., 0.], [1.1234567, 0., 0.], [0., 1.1234567, 0.]],
        [[0., 0., 0.], [-1., 0., 0.], [-0.5, -1., 4. / 65536.]],
    ]);
    assert_ne!(source.positions, source_grid(&source));
    assert_eq!(
        weld_near_coplanar_facets(&source).positions,
        source.positions
    );
}

/// The original jitter-repair case must still fit: both endpoints of its
/// shared edge occupy the existing 100-micrometre canonical cells, even
/// though their input positions differ by 15 micrometres.
#[test]
fn issue_7633_connected_offset_jitter_still_joins_shared_edge() {
    let j = 15e-6;
    let source = triangles(&[
        [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
        [[1., 0., j], [1., 1., j], [0., 1., j]],
    ]);
    assert_ne!(&source.positions[3..6], &source.positions[9..12]);
    let result = weld_near_coplanar_facets(&source);
    assert_eq!(&result.positions[3..6], &result.positions[9..12]);
    assert_eq!(&result.positions[6..9], &result.positions[15..18]);
}
