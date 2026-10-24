// SPDX-License-Identifier: MPL-2.0
//! Pre-copy admission of actual private-driver typed arrays. No await occurs
//! between inspecting their lengths, reserving backing and copying them.
use super::{bridge::{driver_error, Mesh}, BrowserError};
use ifc_lite_geometry::{document::retained_source::SourceTriangleAdmission,
    resource::{Cost, OwnedResourceContext}};
use wasm_bindgen::{JsCast, JsValue};

#[cfg(test)]
thread_local! { static COPIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub(super) fn copy_count() -> usize { COPIES.with(|count| count.get()) }

pub(super) fn read(value: JsValue, resources: &OwnedResourceContext, max_bytes: usize)
    -> Result<Mesh, BrowserError> {
    let invalid = || BrowserError::Driver("invalid source mesh backing lengths".into());
    // Hold typed-array identities, not merely a caller-supplied length report.
    let positions: js_sys::Float64Array = field(&value, "positions")?;
    let indices: js_sys::Uint32Array = field(&value, "indices")?;
    let normals: js_sys::Float64Array = field(&value, "flat_corner_normals")?;
    let faces: js_sys::Uint32Array = field(&value, "revision_local_faces")?;
    let roots: js_sys::Uint32Array = field(&value, "construction_roots")?;
    let inventory: js_sys::Uint8Array = field(&value, "source_inventory")?;
    let handle: js_sys::Uint8Array = field(&value, "source_handle")?;
    let (p,i,n,f,r) = (positions.length() as usize, indices.length() as usize,
        normals.length() as usize, faces.length() as usize, roots.length() as usize);
    if p == 0 || !p.is_multiple_of(3) || i == 0 || !i.is_multiple_of(3) ||
        n != i.checked_mul(3).ok_or_else(invalid)? || f != i/3 || r != f ||
        !(80..=3200).contains(&inventory.length()) || handle.length() != 16 {
        return Err(invalid());
    }
    let bytes = [(p,8), (i,4), (n,8), (f,4), (inventory.length() as usize,1), (16,1)]
        .into_iter().try_fold(0usize, |total, (count,width)| total.checked_add(count.checked_mul(width)?))
        .ok_or_else(invalid)?;
    let total = bytes.checked_add(r.checked_mul(4).ok_or_else(invalid)?).ok_or_else(invalid)?;
    if total > max_bytes { return Err(BrowserError::Driver("source mesh exceeds copy limit".into())); }
    let scalar = |name: &str| -> Result<u32, BrowserError> {
        let number = js_sys::Reflect::get(&value, &JsValue::from_str(name)).map_err(driver_error)?
            .as_f64().ok_or_else(invalid)?;
        if !number.is_finite() || number < 0. || number > u32::MAX as f64 || number.fract() != 0. {
            return Err(invalid());
        }
        Ok(number as u32)
    };
    let source_face_count = scalar("source_face_count")?;
    let boundary_edges = scalar("boundary_edges")?;
    let spine_edges = scalar("spine_edges")?;
    if source_face_count == 0 || boundary_edges != 0 || spine_edges != 0 { return Err(invalid()); }
    // Exact-length typed-array copies avoid serde Vec growth beyond the admitted
    // requested backing. No array is copied before BOTH lifetimes are admitted.
    let triangles = SourceTriangleAdmission::new(r, resources)
        .map_err(|error| BrowserError::Driver(error.into()))?;
    let storage = resources.charge(Cost { live_bytes: bytes as u64, copy_bytes: bytes as u64,
        ..Default::default() }).map_err(|_| BrowserError::Driver("captured source mesh backing account".into()))?;
    #[cfg(test)]
    COPIES.with(|count| count.set(count.get()+1));
    let mut mesh = Mesh {
        positions: positions.to_vec(), indices: indices.to_vec(), flat_corner_normals: normals.to_vec(),
        revision_local_faces: faces.to_vec(), construction_roots: roots.to_vec(),
        source_inventory: inventory.to_vec(), source_handle: handle.to_vec(),
        source_face_count, boundary_edges, spine_edges, empty:false, storage:None, triangle_storage:None,
    };
    mesh.storage = Some(storage);
    mesh.triangle_storage = Some(triangles);
    Ok(mesh)
}
fn field<T: JsCast>(value: &JsValue, name: &str) -> Result<T, BrowserError> {
    js_sys::Reflect::get(value, &JsValue::from_str(name)).map_err(driver_error)?
        .dyn_into().map_err(|_| BrowserError::Driver("source mesh array type mismatch".into()))
}

/// Bounded wire metadata is also admitted before Uint8Array copies it to Rust.
pub(super) fn packet(value: &JsValue, resources: &OwnedResourceContext)
    -> Result<(Vec<u8>, Vec<u8>, ifc_lite_geometry::resource::Reservation), BrowserError> {
    let field = |name: &str| -> Result<js_sys::Uint8Array, BrowserError> {
        js_sys::Reflect::get(value, &JsValue::from_str(name)).map_err(driver_error)?
            .dyn_into().map_err(|_| BrowserError::Driver("source packet is not a byte array".into()))
    };
    let handle = field("source_handle")?;
    let inventory = field("source_inventory")?;
    if handle.length() != 16 || !(80..=3200).contains(&inventory.length()) {
        return Err(BrowserError::Driver("source packet length bound".into()));
    }
    let bytes = u64::from(handle.length()) + u64::from(inventory.length());
    let storage = resources.charge(Cost { live_bytes: bytes, copy_bytes: bytes, ..Default::default() })
        .map_err(|_| BrowserError::Driver("captured source packet backing account".into()))?;
    Ok((handle.to_vec(), inventory.to_vec(), storage))
}
