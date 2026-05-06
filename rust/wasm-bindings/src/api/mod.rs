// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! JavaScript API for IFC-Lite
//!
//! Modern async/await API for parsing IFC files.

mod debug;
mod extract_profiles;
mod georef;
mod gpu_meshes;
mod parsing;
mod quantized_meshes;
pub(crate) mod styling;
mod symbolic;
mod zero_copy_api;

use std::cell::RefCell;

use crate::zero_copy::{MeshCollection, MeshDataJs};
use ifc_lite_core::{EntityIndex, GeoReference, RtcOffset};
use wasm_bindgen::prelude::*;

/// Georeferencing information exposed to JavaScript
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct GeoReferenceJs {
    /// CRS name (e.g., "EPSG:32632")
    #[wasm_bindgen(skip)]
    pub crs_name: Option<String>,
    /// Eastings (X offset)
    pub eastings: f64,
    /// Northings (Y offset)
    pub northings: f64,
    /// Orthogonal height (Z offset)
    pub orthogonal_height: f64,
    /// X-axis abscissa (cos of rotation)
    pub x_axis_abscissa: f64,
    /// X-axis ordinate (sin of rotation)
    pub x_axis_ordinate: f64,
    /// Scale factor
    pub scale: f64,
}

#[wasm_bindgen]
impl GeoReferenceJs {
    /// Get CRS name
    #[wasm_bindgen(getter, js_name = crsName)]
    pub fn crs_name(&self) -> Option<String> {
        self.crs_name.clone()
    }

    /// Get rotation angle in radians
    #[wasm_bindgen(getter)]
    pub fn rotation(&self) -> f64 {
        self.x_axis_ordinate.atan2(self.x_axis_abscissa)
    }

    /// Transform local coordinates to map coordinates
    #[wasm_bindgen(js_name = localToMap)]
    pub fn local_to_map(&self, x: f64, y: f64, z: f64) -> Vec<f64> {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        let s = self.scale;

        let e = s * (cos_r * x - sin_r * y) + self.eastings;
        let n = s * (sin_r * x + cos_r * y) + self.northings;
        let h = z + self.orthogonal_height;

        vec![e, n, h]
    }

    /// Transform map coordinates to local coordinates
    #[wasm_bindgen(js_name = mapToLocal)]
    pub fn map_to_local(&self, e: f64, n: f64, h: f64) -> Vec<f64> {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        let inv_scale = if self.scale.abs() < f64::EPSILON {
            1.0
        } else {
            1.0 / self.scale
        };

        let dx = e - self.eastings;
        let dy = n - self.northings;

        let x = inv_scale * (cos_r * dx + sin_r * dy);
        let y = inv_scale * (-sin_r * dx + cos_r * dy);
        let z = h - self.orthogonal_height;

        vec![x, y, z]
    }

    /// Get 4x4 transformation matrix (column-major for WebGL)
    #[wasm_bindgen(js_name = toMatrix)]
    pub fn to_matrix(&self) -> Vec<f64> {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        let s = self.scale;

        vec![
            s * cos_r,
            s * sin_r,
            0.0,
            0.0,
            -s * sin_r,
            s * cos_r,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            self.eastings,
            self.northings,
            self.orthogonal_height,
            1.0,
        ]
    }
}

impl From<GeoReference> for GeoReferenceJs {
    fn from(geo: GeoReference) -> Self {
        Self {
            crs_name: geo.crs_name,
            eastings: geo.eastings,
            northings: geo.northings,
            orthogonal_height: geo.orthogonal_height,
            x_axis_abscissa: geo.x_axis_abscissa,
            x_axis_ordinate: geo.x_axis_ordinate,
            scale: geo.scale,
        }
    }
}

/// RTC offset information exposed to JavaScript
#[wasm_bindgen]
#[derive(Debug, Clone, Default)]
pub struct RtcOffsetJs {
    /// X offset (subtracted from positions)
    pub x: f64,
    /// Y offset
    pub y: f64,
    /// Z offset
    pub z: f64,
}

#[wasm_bindgen]
impl RtcOffsetJs {
    /// Check if offset is significant (>10km)
    #[wasm_bindgen(js_name = isSignificant)]
    pub fn is_significant(&self) -> bool {
        const THRESHOLD: f64 = 10000.0;
        self.x.abs() > THRESHOLD || self.y.abs() > THRESHOLD || self.z.abs() > THRESHOLD
    }

    /// Convert local coordinates to world coordinates
    #[wasm_bindgen(js_name = toWorld)]
    pub fn to_world(&self, x: f64, y: f64, z: f64) -> Vec<f64> {
        vec![x + self.x, y + self.y, z + self.z]
    }
}

impl From<RtcOffset> for RtcOffsetJs {
    fn from(offset: RtcOffset) -> Self {
        Self {
            x: offset.x,
            y: offset.y,
            z: offset.z,
        }
    }
}

/// Statistics tracking for geometry parsing
#[derive(Default)]
struct GeometryStats {
    total: u32,
    success: u32,
    decode_failed: u32,
    no_representation: u32,
    process_failed: u32,
    empty_mesh: u32,
    outlier_filtered: u32,
}

/// Mesh collection with RTC offset for large coordinates
#[wasm_bindgen]
pub struct MeshCollectionWithRtc {
    meshes: MeshCollection,
    rtc_offset: RtcOffsetJs,
}

#[wasm_bindgen]
impl MeshCollectionWithRtc {
    /// Get the mesh collection
    #[wasm_bindgen(getter)]
    pub fn meshes(&self) -> MeshCollection {
        self.meshes.clone()
    }

    /// Get the RTC offset
    #[wasm_bindgen(getter, js_name = rtcOffset)]
    pub fn rtc_offset(&self) -> RtcOffsetJs {
        self.rtc_offset.clone()
    }

    /// Get number of meshes
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.meshes.len()
    }

    /// Get mesh at index
    pub fn get(&self, index: usize) -> Option<MeshDataJs> {
        self.meshes.get(index)
    }
}

/// Main IFC-Lite API
#[wasm_bindgen]
pub struct IfcAPI {
    initialized: bool,
    /// Cached entity index from buildPrePassOnce, reused by processGeometryBatch
    cached_entity_index: RefCell<Option<EntityIndex>>,
}

#[wasm_bindgen]
impl IfcAPI {
    /// Create and initialize the IFC API
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        Self { initialized: true, cached_entity_index: RefCell::new(None) }
    }

    /// Check if API is initialized
    #[wasm_bindgen(getter)]
    pub fn is_ready(&self) -> bool {
        self.initialized
    }

    /// Clear the cached entity index (call after streaming is complete)
    #[wasm_bindgen(js_name = clearPrePassCache)]
    pub fn clear_pre_pass_cache(&self) {
        self.cached_entity_index.borrow_mut().take();
    }

    /// Get WASM memory for zero-copy access
    #[wasm_bindgen(js_name = getMemory)]
    pub fn get_memory(&self) -> JsValue {
        crate::zero_copy::get_memory()
    }

    /// Get version string
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

impl Default for IfcAPI {
    fn default() -> Self {
        Self::new()
    }
}

/// Safely set a property on a JavaScript object.
/// Returns true if successful, false otherwise.
/// This avoids panicking on edge cases like non-extensible objects.
#[inline]
fn set_js_prop(obj: &JsValue, key: &str, value: &JsValue) -> bool {
    js_sys::Reflect::set(obj, &JsValue::from_str(key), value).unwrap_or(false)
}

/// Safely set a property on a JavaScript object using JsValue key.
/// Returns true if successful, false otherwise.
#[inline]
fn set_js_prop_jv(obj: &JsValue, key: &JsValue, value: &JsValue) -> bool {
    js_sys::Reflect::set(obj, key, value).unwrap_or(false)
}

/// Convert entity counts map to JavaScript object
fn counts_to_js(counts: &rustc_hash::FxHashMap<String, usize>) -> JsValue {
    let obj = js_sys::Object::new();

    for (type_name, count) in counts {
        let key = JsValue::from_str(type_name.as_str());
        let value = JsValue::from_f64(*count as f64);
        set_js_prop_jv(&obj, &key, &value);
    }

    obj.into()
}
