// SPDX-License-Identifier: MPL-2.0
//! Only this imported driver can mint a browser numerical receipt.
use super::*;
use ifc_lite_geometry::document::{
    retained_sweep::RegionQualification, RetainedRequest, RetainedTessellation,
};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen(module = "/js/retained-driver.mjs")]
extern "C" {
    #[wasm_bindgen(js_name = RetainedDriver)]
    pub(super) type Driver;
    #[wasm_bindgen(constructor, catch)]
    fn new() -> Result<Driver, JsValue>;
    #[wasm_bindgen(method)]
    pub(super) fn live(this: &Driver) -> bool;
    #[wasm_bindgen(method)]
    pub(super) fn retire(this: &Driver);
    #[wasm_bindgen(method, js_name = objectLive)]
    pub(super) fn object_live(this: &Driver, object: &JsValue) -> bool;
    #[wasm_bindgen(method)]
    fn qualify(this: &Driver) -> js_sys::Promise;
    #[cfg(test)]
    #[wasm_bindgen(method, js_name = firstDispatch)]
    fn first_dispatch(this: &Driver) -> js_sys::Promise;
    #[wasm_bindgen(method)]
    fn evaluate(
        this: &Driver,
        bytes: &[u8],
        format: u32,
        loops: u32,
        segments: u32,
        qualification: u32,
        chord: f64,
        angle: f64,
        max_bytes: u32,
    ) -> js_sys::Promise;
}

#[derive(serde::Deserialize)]
struct Mesh {
    positions: Vec<f64>,
    indices: Vec<u32>,
    flat_corner_normals: Vec<f64>,
    revision_local_faces: Vec<u32>,
    source_face_count: u32,
    boundary_edges: u32,
    spine_edges: u32,
}

impl BrowserWorker {
    pub fn new() -> Result<Self, JsValue> {
        Ok(Self {
            owner: Arc::new(Owner {
                identity: next_identity(),
                live: AtomicBool::new(true),
                driver: Driver::new()?,
            }),
            qualified: false,
        })
    }
    /// Explicit actual same-incarnation numerical witnesses, separate from
    /// source/IFC qualification. No feature bit can open this gate.
    pub async fn qualify(&mut self) -> Result<(), JsValue> {
        let mut flight = InFlight::new(&self.owner);
        JsFuture::from(self.owner.driver.qualify()).await?;
        self.owner.validate().map_err(error)?;
        self.qualified = true;
        flight.disarm();
        Ok(())
    }
    pub async fn evaluate(
        &mut self,
        request: RetainedRequest,
        chord: f64,
        angle: f64,
        max_bytes: u32,
    ) -> Result<BrowserRealization, JsValue> {
        self.owner.validate().map_err(error)?;
        if request.worker_incarnation() != self.incarnation() {
            return Err(error(RetainedRefusal::InvalidRuntime));
        }
        let payload = request.recipe().lower().map_err(error)?;
        let qualification = match payload.qualification {
            RegionQualification::Rectangle => 0,
            RegionQualification::OrderedRegion => 1,
            RegionQualification::RationalDisk => 2,
        };
        if qualification != 0 && !self.qualified {
            return Err(error(RetainedRefusal::UnqualifiedRegion));
        }
        let mut flight = InFlight::new(&self.owner);
        let value = JsFuture::from(self.owner.driver.evaluate(
            &payload.bytes,
            payload.format,
            payload.loops,
            payload.segments,
            qualification,
            chord,
            angle,
            max_bytes,
        ))
        .await?;
        self.owner.validate().map_err(error)?;
        let object = js_sys::Reflect::get(&value, &JsValue::from_str("object"))?;
        if !self.owner.driver.object_live(&object) {
            return Err(error(RetainedRefusal::InvalidRuntime));
        }
        let mesh: Mesh = serde_wasm_bindgen::from_value(js_sys::Reflect::get(
            &value,
            &JsValue::from_str("mesh"),
        )?)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let realization = BrowserRealization {
            owner: self.owner.clone(),
            object,
            object_live: Arc::new(AtomicBool::new(true)),
            completion: RetainedCompletion::new(
                request,
                RetainedTessellation {
                    positions: mesh.positions,
                    indices: mesh.indices,
                    flat_corner_normals: mesh.flat_corner_normals,
                    revision_local_faces: mesh.revision_local_faces,
                    source_face_count: mesh.source_face_count,
                    boundary_edges: mesh.boundary_edges,
                    spine_edges: mesh.spine_edges,
                },
                payload.source_from_evaluation,
                payload.evaluation_from_source,
            ),
        };
        realization.validate_live().map_err(error)?;
        flight.disarm();
        Ok(realization)
    }
}
fn error(error: RetainedRefusal) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[cfg(test)]
#[path = "browser_bridge_tests.rs"]
mod tests;
