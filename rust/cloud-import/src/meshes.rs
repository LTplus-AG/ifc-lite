/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
use crate::{matrix, Result, MAX_OCCURRENCES, MAX_POINTS};
use gltf::{buffer::Source, mesh::Mode};
use nalgebra::{Matrix4, Vector4};
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn extract(bytes: &[u8], rep: &Value, forma: &Matrix4<f64>, total: &mut usize) -> Result<Vec<Value>> {
    let glb = gltf::Gltf::from_slice(bytes).map_err(|_| "Invalid GLB mesh")?;
    let binary = glb.blob.as_ref().ok_or("Forma mesh must be binary GLB")?;
    if glb.document.buffers().any(|b| !matches!(b.source(), Source::Bin)) {
        return Err("External GLB buffers are not allowed".into());
    }
    let selection = rep.get("selection");
    let legacy = rep.get("id").and_then(Value::as_str);
    let scene = glb.default_scene().or_else(|| glb.scenes().next()).ok_or("GLB contains no scene")?;
    let mut stack: Vec<_> = scene.nodes().map(|n| (n, Matrix4::identity(), HashSet::new())).collect();
    let mut visits = 0;
    let mut output = Vec::new();
    while let Some((node, parent, mut ancestors)) = stack.pop() {
        visits += 1;
        if visits > MAX_OCCURRENCES || ancestors.len() > 256 { return Err("GLB hierarchy exceeds the limit".into()); }
        if !ancestors.insert(node.index()) { return Err("Cycle in GLB hierarchy".into()); }
        if node.skin().is_some() || !node.weights().unwrap_or(&[]).is_empty() {
            return Err("Skinned/morphed GLB is not supported".into());
        }
        let local = node.transform().matrix();
        let flat = std::array::from_fn(|i| f64::from(local[i / 4][i % 4]));
        let world = parent * matrix(Some(flat))?;
        for child in node.children() { stack.push((child, world, ancestors.clone())); }
        let Some(mesh) = node.mesh() else { continue };
        let name = mesh.name().unwrap_or("");
        let selected = if let Some(selection) = selection {
            let value = selection["value"].as_str().ok_or("Invalid mesh selection")?;
            match selection["type"].as_str() {
                Some("equals") => name == value,
                Some("startsWith") => name.starts_with(value),
                _ => return Err("Unsupported mesh selection".into()),
            }
        } else { legacy.is_none_or(|id| name == id) };
        if !selected { continue }
        for primitive in mesh.primitives() {
            if primitive.mode() != Mode::Triangles { return Err("Only GLB triangles are supported".into()); }
            if primitive.morph_targets().next().is_some() { return Err("GLB morph targets are not supported".into()); }
            let reader = primitive.reader(|buffer| match buffer.source() { Source::Bin => Some(binary.as_slice()), _ => None });
            let positions = reader.read_positions().ok_or("GLB primitive has no positions")?;
            let mut points = Vec::new();
            for p in positions {
                *total += 1;
                if *total > MAX_POINTS { return Err("Forma geometry exceeds the point limit".into()); }
                // glTF local hierarchy Y-up -> Forma Z-up -> Forma occurrence hierarchy.
                let y = world * Vector4::new(f64::from(p[0]), f64::from(p[1]), f64::from(p[2]), 1.0);
                let z = forma * Vector4::new(y.x, -y.z, y.y, 1.0);
                if !z.iter().all(|v| v.is_finite()) { return Err("Non-finite GLB position".into()); }
                points.push([z.x, z.y, z.z]);
            }
            let mut indices: Vec<u32> = if let Some(indices) = reader.read_indices() { indices.into_u32().collect() }
                else { (0..u32::try_from(points.len()).map_err(|_| "GLB point count overflow")?).collect() };
            if !indices.len().is_multiple_of(3) || indices.iter().any(|i| *i as usize >= points.len()) { return Err("Invalid GLB triangle indices".into()); }
            if world.fixed_view::<3, 3>(0, 0).determinant() * forma.fixed_view::<3, 3>(0, 0).determinant() < 0.0 {
                for triangle in indices.chunks_exact_mut(3) { triangle.swap(1, 2); }
            }
            let material = primitive.material().pbr_metallic_roughness();
            let color = material.base_color_factor();
            let opacity = if primitive.material().alpha_mode() == gltf::material::AlphaMode::Opaque { 1.0 } else { color[3] };
            output.push(json!({
                "usd::usdgeom::mesh":{"points":points,"faceVertexIndices":indices},
                "bsi::ifc::presentation::diffuseColor":[color[0],color[1],color[2]],
                "bsi::ifc::presentation::opacity":opacity,
                "autodesk::Material":{"MetallicFactor":material.metallic_factor(),"RoughnessFactor":material.roughness_factor(),"AlphaMaskApproximated":primitive.material().alpha_mode() == gltf::material::AlphaMode::Mask},
                // These limitations travel with the artifact; no fabricated material fidelity.
                "autodesk::TextureOmitted":material.base_color_texture().is_some(),
                "autodesk::VertexColorsOmitted":reader.read_colors(0).is_some()
            }));
        }
    }
    Ok(output)
}
