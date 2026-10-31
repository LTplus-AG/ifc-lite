// SPDX-License-Identifier: MPL-2.0
//! Retained shape-only display storage. Placement stays f64 until the final cast.
use ifc_lite_geometry::Mesh;
use ifc_lite_processing::element::retained_runtime::{ShapeOnlyProduct, ShapePart, NO_PALETTE_ENTRY};

// Native witnesses exercise the part converter; products require publication authority.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn view_meshes(product: &ShapeOnlyProduct, frame_rtc: [f64; 3]) -> Vec<ifc_lite_processing::MeshData> {
    let mut meshes = Vec::with_capacity(product.parts.len());
    for part in &product.parts {
        let base = part.appearance.as_ref().map_or_else(
            || ifc_lite_processing::style::default_color_for_type(product.ifc_type.clone()).to_array(),
            |appearance| appearance.rgba);
        for (triangles, palette_entry, textured) in surface_groups(part) {
            let mesh = view_triangles(part, frame_rtc, triangles.as_deref());
            let color = palette_entry.and_then(|entry| part.surface.as_ref()?.palette.as_ref()?.colours.get(entry as usize).copied())
                .unwrap_or(base);
            let vertices = mesh.positions.len() / 3;
            let mut data = ifc_lite_processing::MeshData::new(product.product_id,
                product.ifc_type.name().into(), mesh.positions, mesh.normals, mesh.indices, color)
                .with_origin(mesh.origin);
            if let Some(appearance) = &part.appearance {
                data.geometry_class = appearance.geometry_class;
                data.material_name = appearance.material_name.clone();
                data.geometry_item_id = appearance.geometry_item_id;
                data.material_id = appearance.material_id;
            }
            if let (true, Some(texture)) = (textured, part.surface.as_ref().and_then(|s| s.texture.as_ref())) {
                // The GPU convention exact's mesher writes: V flipped from the IFC source.
                let mut uvs = Vec::with_capacity(vertices * 2);
                let mut push = |t: usize| for corner in 0..3 {
                    let at = (t * 3 + corner) * 2;
                    uvs.extend([texture.uvs[at] as f32, 1. - texture.uvs[at + 1] as f32]);
                };
                match &triangles { Some(list) => list.iter().copied().for_each(&mut push), None => (0..part.indices.len() / 3).for_each(&mut push) }
                data.uvs = Some(uvs);
                data.texture = Some(ifc_lite_processing::MeshTextureData::from_attachment(&texture.attachment));
            }
            meshes.push(data);
        }
    }
    meshes
}

/// One display mesh per palette colour and textured state, as exact splits a palette
/// (#858). `None` triangles is the whole part: an unbound part stays one mesh.
pub(crate) type SurfaceGroup = (Option<Vec<usize>>, Option<u32>, bool);
pub(crate) fn surface_groups(part: &ShapePart) -> Vec<SurfaceGroup> {
    let Some(surface) = &part.surface else { return vec![(None, None, false)] };
    let mut groups = std::collections::BTreeMap::<(u32, bool), Vec<usize>>::new();
    for t in 0..part.indices.len() / 3 {
        let entry = surface.palette.as_ref().map_or(NO_PALETTE_ENTRY, |p| p.triangles[t]);
        let textured = surface.texture.as_ref().is_some_and(|x| x.textured[t]);
        groups.entry((entry, textured)).or_default().push(t);
    }
    groups.into_iter().map(|((entry, textured), triangles)|
        (Some(triangles), (entry != NO_PALETTE_ENTRY).then_some(entry), textured)).collect()
}

// Native witnesses exercise the whole-part view; the wasm event builds per surface group.
#[allow(dead_code)]
pub(crate) fn view_part(part: &ShapePart, rtc: [f64; 3]) -> Mesh {
    view_triangles(part, rtc, None)
}

fn view_triangles(part: &ShapePart, rtc: [f64; 3], only: Option<&[usize]>) -> Mesh {
    let m = &part.world_from_object;
    let translation = [m[12], m[13], m[14]];
    let origin = std::array::from_fn(|axis| translation[axis] - rtc[axis]);
    let mut mesh = Mesh::with_capacity(part.indices.len(), part.indices.len());
    mesh.origin = origin;
    mesh.rtc_applied = true;
    let count = only.map_or(part.indices.len() / 3, <[usize]>::len);
    for position in 0..count {
        let triangle_index = only.map_or(position, |list| list[position]);
        let triangle = &part.indices[triangle_index * 3..triangle_index * 3 + 3];
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
        for (corner, w) in world.into_iter().enumerate() {
            mesh.indices.push(mesh.vertex_count() as u32);
            for axis in 0..3 {
                mesh.positions
                    .push((w[axis] - rtc[axis] - origin[axis]) as f32);
            }
            if let Some(normals) = &part.normals {
                let start = (triangle_index * 3 + corner) * 3;
                mesh.normals.extend(normals[start..start + 3].iter().map(|n| *n as f32));
            } else {
                mesh.normals.extend_from_slice(&normal);
            }
        }
    }
    mesh
}
