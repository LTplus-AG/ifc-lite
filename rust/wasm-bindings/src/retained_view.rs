// SPDX-License-Identifier: MPL-2.0
//! Retained shape-only display storage. Placement stays f64 until the final cast.
use ifc_lite_geometry::Mesh;
use ifc_lite_processing::element::retained_runtime::{ShapeOnlyProduct, ShapePart};

// Native witnesses exercise the part converter; products require publication authority.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn view_meshes(product: &ShapeOnlyProduct, frame_rtc: [f64; 3]) -> Vec<Mesh> {
    product
        .parts
        .iter()
        .map(|part| view_part(part, frame_rtc))
        .collect()
}

pub(crate) fn view_part(part: &ShapePart, rtc: [f64; 3]) -> Mesh {
    let m = &part.world_from_object;
    let translation = [m[12], m[13], m[14]];
    let origin = std::array::from_fn(|axis| translation[axis] - rtc[axis]);
    let mut mesh = Mesh::with_capacity(part.indices.len(), part.indices.len());
    mesh.origin = origin;
    mesh.rtc_applied = true;
    for triangle in part.indices.chunks_exact(3) {
        let world: [[f64; 3]; 3] = std::array::from_fn(|corner| {
            let i = triangle[corner] as usize * 3;
            let p = &part.positions[i..i + 3];
            std::array::from_fn(|axis| {
                m[axis] * p[0] + m[4 + axis] * p[1] + m[8 + axis] * p[2] + translation[axis]
            })
        });
        let a: [f64; 3] = std::array::from_fn(|i| world[1][i] - world[0][i]);
        let b: [f64; 3] = std::array::from_fn(|i| world[2][i] - world[0][i]);
        let n = [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ];
        let length = n.iter().map(|v| v * v).sum::<f64>().sqrt();
        let normal = n.map(|v| if length > 0. { (v / length) as f32 } else { 0. });
        for w in world {
            mesh.indices.push(mesh.vertex_count() as u32);
            for axis in 0..3 {
                mesh.positions
                    .push((w[axis] - rtc[axis] - origin[axis]) as f32);
            }
            mesh.normals.extend_from_slice(&normal);
        }
    }
    mesh
}
