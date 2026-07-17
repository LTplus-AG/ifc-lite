// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounding-box collapse: replace a mesh with its 12-triangle AABB box.
//!
//! Port of `buildBoxMeshFromAabb` in `packages/export/src/lod1-generator.ts`
//! (same 24-vertex flat-shaded layout and winding), over the mesh's
//! positions-frame AABB so the box lives in the same frame as the input
//! (`world = origin + position` keeps holding).

use crate::mesh::Mesh;

/// 12-triangle box spanning the mesh's positions-frame AABB, carrying the
/// input's placement/frame metadata. An empty input is returned as an empty
/// clone (nothing to bound).
pub(crate) fn box_from_positions_aabb(mesh: &Mesh) -> Mesh {
    if mesh.is_empty() {
        return mesh.clone();
    }
    let (min, max) = mesh.bounds();
    box_from_corners(mesh, [min.x, min.y, min.z], [max.x, max.y, max.z])
}

/// Flat-shaded AABB box between `min` and `max`, frame metadata carried from
/// `template` via `rebuilt_like` (valid: the box corners equal the positions
/// AABB, so the extent never grows).
pub(crate) fn box_from_corners(template: &Mesh, min: [f32; 3], max: [f32; 3]) -> Mesh {
    let [x0, y0, z0] = min;
    let [x1, y1, z1] = max;

    #[rustfmt::skip]
    let positions: Vec<f32> = vec![
        // bottom (z0) - normal [0,0,-1]
        x0,y0,z0,  x1,y0,z0,  x1,y1,z0,  x0,y1,z0,
        // top (z1) - normal [0,0,1]
        x0,y0,z1,  x1,y0,z1,  x1,y1,z1,  x0,y1,z1,
        // front (y0) - normal [0,-1,0]
        x0,y0,z0,  x1,y0,z0,  x1,y0,z1,  x0,y0,z1,
        // back (y1) - normal [0,1,0]
        x0,y1,z0,  x1,y1,z0,  x1,y1,z1,  x0,y1,z1,
        // left (x0) - normal [-1,0,0]
        x0,y0,z0,  x0,y1,z0,  x0,y1,z1,  x0,y0,z1,
        // right (x1) - normal [1,0,0]
        x1,y0,z0,  x1,y1,z0,  x1,y1,z1,  x1,y0,z1,
    ];

    #[rustfmt::skip]
    let normals: Vec<f32> = vec![
        0.0,0.0,-1.0, 0.0,0.0,-1.0, 0.0,0.0,-1.0, 0.0,0.0,-1.0, // bottom
        0.0,0.0, 1.0, 0.0,0.0, 1.0, 0.0,0.0, 1.0, 0.0,0.0, 1.0, // top
        0.0,-1.0,0.0, 0.0,-1.0,0.0, 0.0,-1.0,0.0, 0.0,-1.0,0.0, // front
        0.0, 1.0,0.0, 0.0, 1.0,0.0, 0.0, 1.0,0.0, 0.0, 1.0,0.0, // back
        -1.0,0.0,0.0, -1.0,0.0,0.0, -1.0,0.0,0.0, -1.0,0.0,0.0, // left
         1.0,0.0,0.0,  1.0,0.0,0.0,  1.0,0.0,0.0,  1.0,0.0,0.0, // right
    ];

    // Winding follows the right-hand rule so cross(e1, e2) matches the
    // declared per-face normal (same as the TS original).
    #[rustfmt::skip]
    let indices: Vec<u32> = vec![
        0,2,1,    0,3,2,    // bottom  (normal  0, 0,-1)
        4,5,6,    4,6,7,    // top     (normal  0, 0, 1)
        8,9,10,   8,10,11,  // front   (normal  0,-1, 0)
        12,14,13, 12,15,14, // back    (normal  0, 1, 0)
        16,18,17, 16,19,18, // left    (normal -1, 0, 0)
        20,21,22, 20,22,23, // right   (normal  1, 0, 0)
    ];

    template.rebuilt_like(positions, normals, indices)
}
