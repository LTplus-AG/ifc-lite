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
    #[wasm_bindgen(method, js_name = releaseObject)]
    pub(super) fn release_object(this: &Driver, object: &JsValue);
    #[wasm_bindgen(method, js_name = copyAffine)]
    pub(super) fn copy_affine(this: &Driver, source: &JsValue, matrix: &[f64]) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = evaluateBoolean)]
    pub(super) fn evaluate_boolean(this: &Driver, left: &JsValue, right: &JsValue,
        relative: &[f64], operation: u32, chord: f64, angle: f64, max_bytes: u32) -> js_sys::Promise;
    #[wasm_bindgen(method)]
    fn qualify(this: &Driver) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = qualifyDependencies)]
    fn qualify_dependencies(this: &Driver) -> js_sys::Promise;
    #[cfg(test)]
    #[wasm_bindgen(method, js_name = nextDispatch)]
    pub(super) fn next_dispatch(this: &Driver, opcode: u32) -> js_sys::Promise;
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
    pub fn new() -> Result<Self, JsValue> { Self::create(false) }
    /// Explicit graph numerical execution. Independent object leases do not
    /// grant common-product coverage or change the source-only constructor.
    pub fn new_retained_execution() -> Result<Self, JsValue> { Self::create(true) }
    fn create(independent_leases: bool) -> Result<Self, JsValue> {
        Ok(Self {
            owner: Arc::new(Owner {
                identity: next_identity(),
                independent_leases,
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
        let qualification = if self.owner.independent_leases { self.owner.driver.qualify_dependencies() }
            else { self.owner.driver.qualify() };
        JsFuture::from(qualification).await?;
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
        // Known caller errors precede the cancellation guard: no numerical
        // command was submitted, so existing object leases remain usable.
        evaluation_limits(chord, angle, max_bytes).map_err(error)?;
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
        let mesh = mesh(&value)?;
        if outcome(&value, &mesh)? != crate::NumericalOutcome::NonEmpty {
            return Err(error(RetainedRefusal::Contract));
        }
        let realization = BrowserRealization {
            owner: self.owner.clone(),
            handle: BrowserObjectHandle::new(),
            object,
            object_live: Arc::new(AtomicBool::new(true)),
            completion: RetainedCompletion::new(
                request,
                mesh,
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

pub(super) fn mesh(value: &JsValue) -> Result<RetainedTessellation, JsValue> {
    let mesh: Mesh = serde_wasm_bindgen::from_value(js_sys::Reflect::get(value,
        &JsValue::from_str("mesh"))?).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(RetainedTessellation { positions: mesh.positions, indices: mesh.indices,
        flat_corner_normals: mesh.flat_corner_normals, revision_local_faces: mesh.revision_local_faces,
        source_face_count: mesh.source_face_count, boundary_edges: mesh.boundary_edges, spine_edges: mesh.spine_edges })
}

// The imported private driver issues this classification only after querying
// the actual result solid. Recheck buffer consistency before sealing Rust data.
pub(super) fn outcome(value: &JsValue, mesh: &RetainedTessellation) -> Result<crate::NumericalOutcome, JsValue> {
    let kind = js_sys::Reflect::get(value, &JsValue::from_str("outcome"))?.as_string();
    let empty = mesh.positions.is_empty() && mesh.indices.is_empty()
        && mesh.flat_corner_normals.is_empty() && mesh.revision_local_faces.is_empty()
        && mesh.source_face_count == 0 && mesh.boundary_edges == 0 && mesh.spine_edges == 0;
    match kind.as_deref() {
        Some("empty") if empty => Ok(crate::NumericalOutcome::Empty),
        Some("nonempty") if !mesh.positions.is_empty() && !mesh.indices.is_empty()
            && mesh.source_face_count > 0 => Ok(crate::NumericalOutcome::NonEmpty),
        _ => Err(error(RetainedRefusal::Contract)),
    }
}
