// SPDX-License-Identifier: MPL-2.0
//! Optional retained-only metadata; never extends the default MeshDataJs ABI.
use super::retained_model::set;
use ifc_lite_processing::element::retained_runtime::{ShapePart, ShapeOnlyProduct, PartFaces};
use js_sys::{Array, Float64Array, Object, Uint32Array};
use wasm_bindgen::JsValue;

fn faces(value: &PartFaces) -> Result<JsValue, JsValue> {
    let result = Object::new();
    let table = Array::new();
    for key in &value.table { table.push(&key.to_string().into()); }
    set(&result, "table", &table)?;
    set(&result, "triangles", &Uint32Array::from(value.triangles.as_slice()))?;
    Ok(result.into())
}
fn key(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub(super) fn part_fields(result: &Object, part: &ShapePart) -> Result<(), JsValue> {
    set(result, "revisionLocalFaces", &Uint32Array::from(part.revision_local_faces.as_slice()))?;
    if let Some(normals) = &part.normals {
        set(result, "normals", &Float64Array::from(normals.as_slice()))?;
    }
    if let Some(appearance) = &part.appearance {
        let color = Array::new();
        for component in appearance.rgba { color.push(&component.into()); }
        set(result, "color", &color)?;
        if let Some(name) = &appearance.material_name { set(result, "materialName", &name.as_str().into())?; }
        if let Some(id) = appearance.geometry_item_id { set(result, "geometryItemId", &id.into())?; }
        if let Some(id) = appearance.material_id { set(result, "materialId", &id.into())?; }
    }
    if let Some(value) = &part.faces { set(result, "faces", &faces(value)?)?; }
    if let Some(surface) = &part.surface {
        if let Some(palette) = &surface.palette {
            let value = Object::new();
            set(&value, "mapId", &palette.map_id.into())?;
            set(&value, "colors", &js_sys::Float32Array::from(palette.colours.as_flattened()))?;
            set(&value, "triangles", &Uint32Array::from(palette.triangles.as_slice()))?;
            set(result, "palette", &value)?;
        }
        if let Some(texture) = &surface.texture {
            let value = Object::new();
            set(&value, "textureId", &texture.attachment.texture_id.into())?;
            set(&value, "uvs", &Float64Array::from(texture.uvs.as_slice()))?;
            let flags: Vec<u8> = texture.textured.iter().map(|&flag| u8::from(flag)).collect();
            set(&value, "textured", &js_sys::Uint8Array::from(flags.as_slice()))?;
            set(result, "texture", &value)?;
        }
    }
    if let Some(value) = &part.instance_key { set(result, "instanceKey", &key(value).into())?; }
    Ok(())
}
pub(super) fn product_fields(result: &Object, product: &ShapeOnlyProduct, view: bool) -> Result<(), JsValue> {
    if view && product.parts.iter().all(|part| part.faces.is_some()) {
        let tables = Array::new();
        for part in &product.parts {
            if let Some(value) = &part.faces { tables.push(&faces(value)?); }
        }
        set(result, "faces", &tables)?;
    }
    // Eligibility requires a single part. Group ownership is assigned by the host.
    if let [part] = product.parts.as_slice() {
        if let Some(value) = &part.instance_key { set(result, "instanceKey", &key(value).into())?; }
    }
    Ok(())
}
