// SPDX-License-Identifier: MPL-2.0
//! Retained-only IFNS boundary. Uses the exact collator and #3666 verifier.
use ifc_lite_geometry::{InstanceMeshRef, InstanceMeta, Matrix4};
use ifc_lite_geometry::math::frame::yup_to_zup;
use ifc_lite_processing::MeshData;
use js_sys::{Array, Object, Uint8Array, Uint32Array};
use serde::Deserialize;
use wasm_bindgen::prelude::*;
use super::super::{gpu_meshes::{is_instancing_candidate, INSTANCE_MIN_OCCURRENCES}, retained_model::set};

/// Minimum occurrence count shared by retained encoding and diagnostic reports.
#[wasm_bindgen(js_name = instanceMinOccurrences)]
pub fn instance_min_occurrences() -> u32 {
    INSTANCE_MIN_OCCURRENCES
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    express_id: u32,
    ifc_type: String,
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    color: [f32; 4],
    world_from_object: [f64; 16],
    #[serde(default)]
    origin: [f64; 3],
    #[serde(default)]
    geometry_class: u8,
    geometry_item_id: Option<u32>,
    material: Option<Finish>,
    texture: Option<serde::de::IgnoredAny>,
}
#[derive(Deserialize)]
struct Finish { metallic: Option<f32>, roughness: Option<f32> }

/// Bounded host batch of baked Y-up meshes and controller-composed IFC frames.
/// Keys are full SHA256 hex strings, never truncated to the collator's u128 id.
#[wasm_bindgen(js_name = encodeInstancedShard, unchecked_return_type = "{ shard: Uint8Array; flatIndices: Uint32Array; instanceCount: number; groupCount: number; verificationRejections: number }")]
pub fn encode_instanced_shard(
    #[wasm_bindgen(unchecked_param_type = "{ expressId: number; ifcType: string; positions: Float32Array; normals: Float32Array; indices: Uint32Array; color: number[]; worldFromObject: Float64Array; origin?: number[]; geometryClass?: number; geometryItemId?: number; material?: { metallic?: number; roughness?: number }; texture?: unknown }[]")]
    meshes: Array,
    #[wasm_bindgen(unchecked_param_type = "string[]")]
    keys: Array,
    rtc: Vec<f64>,
) -> Result<JsValue, JsValue> {
    if meshes.length() > 256 || meshes.length() != keys.length() || rtc.len() != 3 || !rtc.iter().all(|v| v.is_finite()) {
        return Err(JsValue::from_str("Invalid retained instance batch"));
    }
    let mut data = Vec::new();
    let mut frames = Vec::new();
    let mut finishes = Vec::new();
    let mut identities = std::collections::BTreeMap::new();
    for (input, key) in meshes.iter().zip(keys.iter()) {
        let mut input: Input = serde_wasm_bindgen::from_value(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let key = key.as_string().filter(|k| k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| JsValue::from_str("Invalid retained instance key"))?;
        let next_id = identities.len() as u128;
        let id = *identities.entry(key).or_insert(next_id);
        let frame = Matrix4::from_column_slice(&input.world_from_object);
        // MeshDataJs is Y-up; IFNS is native IFC Z-up. Reuse the canonical
        // inverse swap because the renderer applies the forward swap itself.
        for values in [&mut input.positions, &mut input.normals] {
            for xyz in values.chunks_exact_mut(3) {
                xyz.copy_from_slice(&yup_to_zup([xyz[0], xyz[1], xyz[2]]));
            }
        }
        let mut mesh = MeshData::new(input.express_id, input.ifc_type, input.positions, input.normals, input.indices, input.color)
            .with_origin(yup_to_zup(input.origin));
        mesh.geometry_class = input.geometry_class;
        mesh.geometry_item_id = input.geometry_item_id;
        frames.push(InstanceMeta { transform: ifc_lite_geometry::math::mat4::from_na(&frame),
            local_transform: None, canonical_transform: None, rep_identity: id,
            instanceable: is_instancing_candidate(&mesh) && input.texture.is_none() });
        finishes.push(input.material.map_or([f32::NAN; 2], |f| [f.metallic.unwrap_or(f32::NAN), f.roughness.unwrap_or(f32::NAN)]));
        data.push(mesh);
    }
    let refs: Vec<_> = data.iter().zip(&frames).map(|(m, frame)| InstanceMeshRef {
        positions: &m.positions, normals: &m.normals, indices: &m.indices, origin: m.origin,
        instance_meta: Some(frame), entity_id: m.express_id, color: m.color, item_id: m.geometry_item_id,
    }).collect();
    let mut collated = ifc_lite_geometry::collate_refs_in_basis(&refs, INSTANCE_MIN_OCCURRENCES as usize,
        [rtc[0], rtc[1], rtc[2]], None);
    let result = Object::new();
    set(&result, "flatIndices", &Uint32Array::from(collated.flat_indices.iter().map(|i| *i as u32).collect::<Vec<_>>().as_slice()))?;
    set(&result, "instanceCount", &(collated.instanced_occurrence_count() as u32).into())?;
    set(&result, "groupCount", &(collated.templates.len() as u32).into())?;
    set(&result, "verificationRejections", &(collated.verification_rejections as u32).into())?;
    // Rejected groups go to the ordinary consolidated flat path, never IFNS singletons.
    collated.flat_indices.clear();
    let bytes = if collated.templates.is_empty() { Vec::new() }
        else { ifc_lite_geometry::encode_refs_with_finishes(&refs, &collated, &finishes) };
    set(&result, "shard", &Uint8Array::from(bytes.as_slice()))?;
    Ok(result.into())
}
