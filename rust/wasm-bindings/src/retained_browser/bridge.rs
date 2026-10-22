// SPDX-License-Identifier: MPL-2.0
//! wasm32 only: the imported private driver is the sole source of browser
//! numerical results. It never receives a caller transport or buffer.
use super::*;
use ifc_lite_geometry::document::{
    RegionQualification, RetainedCompletion, RetainedRequest, RetainedTessellation,
};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen(module = "/js/retained-driver.mjs")]
extern "C" {
    #[wasm_bindgen(js_name = RetainedDriver)]
    pub(super) type Driver;
    #[wasm_bindgen(constructor, catch, js_class = RetainedDriver)]
    fn new() -> Result<Driver, JsValue>;
    #[wasm_bindgen(method)]
    pub(super) fn live(this: &Driver) -> bool;
    #[wasm_bindgen(method)]
    pub(super) fn retire(this: &Driver);
    #[wasm_bindgen(method, js_name = objectLive)]
    pub(super) fn object_live(this: &Driver, object: &JsValue) -> bool;
    #[wasm_bindgen(method, js_name = releaseObject)]
    pub(super) fn release_object(this: &Driver, object: &JsValue);
    #[wasm_bindgen(method)]
    fn qualify(this: &Driver) -> js_sys::Promise;
    #[wasm_bindgen(method)]
    fn capabilities(this: &Driver) -> js_sys::Promise;
    #[cfg(test)]
    #[wasm_bindgen(method, js_name = nextDispatch)]
    pub(super) fn next_dispatch(this: &Driver, opcode: u32) -> js_sys::Promise;
    #[wasm_bindgen(method)]
    #[allow(clippy::too_many_arguments)]
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

fn driver_error(error: JsValue) -> BrowserError {
    let message = error
        .dyn_ref::<js_sys::Error>()
        .map(|error| String::from(error.message()))
        .or_else(|| error.as_string())
        .unwrap_or_else(|| "unknown driver failure".into());
    BrowserError::Driver(message)
}

impl BrowserWorker {
    /// Explicit allocation of one module Worker. Its `/smlib/` transport is
    /// loaded by this call, never by importing or initializing the package.
    pub fn new() -> Result<Self, BrowserError> {
        let identity = next_identity()?;
        Ok(Self {
            owner: Arc::new(Owner {
                identity,
                live: AtomicBool::new(true),
                driver: Driver::new().map_err(driver_error)?,
            }),
            regions_qualified: false,
            disks_qualified: false,
        })
    }

    /// Run this incarnation's ordered-region and rational-disk SDK witnesses.
    /// No capability bit or feature flag opens the curved gates; a failure
    /// retires this Worker and a replacement must qualify independently.
    pub async fn qualify(&mut self) -> Result<(), BrowserError> {
        self.owner.validate()?;
        self.regions_qualified = false;
        self.disks_qualified = false;
        let mut flight = InFlight::new(&self.owner);
        JsFuture::from(self.owner.driver.qualify())
            .await
            .map_err(driver_error)?;
        self.owner.validate()?;
        flight.disarm();
        self.regions_qualified = true;
        self.disks_qualified = true;
        Ok(())
    }

    /// Select executable families from this actual Worker: its SDK extension
    /// bits (never sufficient alone) and this incarnation's own witnesses.
    pub async fn capabilities(&mut self) -> Result<BrowserCapabilities, BrowserError> {
        self.owner.validate()?;
        let mut flight = InFlight::new(&self.owner);
        let bits = JsFuture::from(self.owner.driver.capabilities())
            .await
            .map_err(driver_error)?
            .as_f64()
            .filter(|bits| bits.fract() == 0. && (0. ..=f64::from(u32::MAX)).contains(bits))
            .ok_or_else(|| BrowserError::Driver("invalid capability bits".into()))? as u32;
        self.owner.validate()?;
        flight.disarm();
        Ok(BrowserCapabilities::select(
            self.owner.identity,
            bits,
            self.regions_qualified,
            self.disks_qualified,
        ))
    }

    /// Execute one retained source request on the incarnation it was prepared
    /// for. Stale requests, invalid limits and unqualified curved families are
    /// refused before anything is submitted, keeping every existing lease.
    /// Dropping the future retires the captured Worker and all of its leases.
    pub async fn evaluate_retained(
        &mut self,
        request: RetainedRequest,
        chord_metres: f64,
        angle_degrees: f64,
        max_bytes: u32,
    ) -> Result<BrowserRealization, BrowserError> {
        self.owner.validate()?;
        if request.worker_incarnation() != self.incarnation() {
            return Err(BrowserError::WrongWorker);
        }
        evaluation_limits(chord_metres, angle_degrees, max_bytes)?;
        let payload = request.payload();
        let (qualification, qualified) = match payload.qualification {
            RegionQualification::Rectangle => (0, true),
            RegionQualification::OrderedRegion => (1, self.regions_qualified),
            RegionQualification::RationalDisk => (2, self.disks_qualified),
            _ => (u32::MAX, false),
        };
        if !qualified {
            return Err(BrowserError::Unqualified(
                "execute this incarnation's numerical witnesses first",
            ));
        }
        let mut flight = InFlight::new(&self.owner);
        let value = JsFuture::from(self.owner.driver.evaluate(
            &payload.bytes,
            payload.format,
            payload.loops,
            payload.segments,
            qualification,
            chord_metres,
            angle_degrees,
            max_bytes,
        ))
        .await
        .map_err(driver_error)?;
        self.owner.validate()?;
        let object = js_sys::Reflect::get(&value, &JsValue::from_str("object")).map_err(driver_error)?;
        let mesh = js_sys::Reflect::get(&value, &JsValue::from_str("mesh")).map_err(driver_error)?;
        let mesh: Mesh = serde_wasm_bindgen::from_value(mesh)
            .map_err(|error| BrowserError::Driver(error.to_string()))?;
        let (source_from_evaluation, evaluation_from_source) = (
            payload.source_from_evaluation,
            payload.evaluation_from_source,
        );
        let realization = BrowserRealization {
            owner: self.owner.clone(),
            object_live: AtomicBool::new(true),
            object,
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
                source_from_evaluation,
                evaluation_from_source,
            ),
        };
        // Accept only a lease the driver still holds for this exact Worker.
        realization.validate_live()?;
        flight.disarm();
        Ok(realization)
    }
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
