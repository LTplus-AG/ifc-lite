// SPDX-License-Identifier: MPL-2.0
//! Private retained-geometry executor: one actual SMLib module Worker per owner.
//!
//! The wasm32 driver (`js/retained-driver.mjs`) loads the deployed `/smlib/`
//! transport only when a [`BrowserWorker`] is constructed; nothing here runs
//! on an ordinary load. Numeric incarnations are bookkeeping, never a
//! constructor of authority: there is no way to build a worker, a receipt or a
//! lease from an integer, a callback, a caller transport or a supplied buffer.
//!
//! Mirrors the native `ifc_lite_geometry_runtime::SmlibWorker` retained
//! contract (that crate stays native-only and unpublished): requests are
//! bound to the incarnation they were prepared for, curved regions and disks
//! need this incarnation's own numerical witnesses, and each realization owns
//! one object lease that is released independently when it is dropped.
//!
//! The Worker constructor and its async operations exist on wasm32 alone;
//! natively only the ownership bookkeeping compiles, for its unit tests.
//! Crate-private: consumed by the retained source and whole-model JavaScript
//! host contracts (`api::retained_browser` and `api::retained_model`).
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

#[cfg(target_arch = "wasm32")]
mod bridge;
#[cfg(target_arch = "wasm32")]
mod runtime;
#[cfg(target_arch = "wasm32")]
pub(crate) mod model;
#[cfg(target_arch = "wasm32")]
mod runtime_mesh;
#[cfg(target_arch = "wasm32")]
mod receipt;
mod fault;

/// Every refusal of the browser executor. A refused call submits nothing
/// unless it says otherwise; an unknown outcome retires the whole Worker.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum BrowserError {
    /// Retired, replaced, or a request/lease of another incarnation.
    WrongWorker,
    /// Invalid chord, angle or byte budget; nothing reached the Worker.
    InvalidLimits,
    /// This incarnation has not run the witnesses this family requires.
    Unqualified(&'static str),
    /// Browser incarnation identities are exhausted.
    Exhausted,
    /// Copied result buffers exceed the admitted byte budget.
    ResourceLimit(String),
    /// The driver, transport or SDK refused or failed (message preserved).
    Driver(String),
    /// Typed SDK status, preserved across the executor boundary.
    Kernel { status: i32, message: String },
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongWorker => write!(f, "browser worker retired or foreign"),
            Self::InvalidLimits => write!(f, "invalid retained evaluation limits"),
            Self::Unqualified(message) => write!(f, "unqualified retained request: {message}"),
            Self::ResourceLimit(message) => write!(f, "browser resource limit: {message}"),
            Self::Exhausted => write!(f, "browser incarnation exhausted"),
            Self::Kernel { status, message } => write!(f, "browser kernel {status}: {message}"),
            Self::Driver(message) => write!(f, "browser worker driver: {message}"),
        }
    }
}
impl std::error::Error for BrowserError {}

/// Chord (metres), angle (degrees, at most 180) and the copied-mesh budget.
pub fn evaluation_limits(chord: f64, angle: f64, max_bytes: u32) -> Result<(), BrowserError> {
    if !chord.is_finite() || chord <= 0. || !angle.is_finite() || angle <= 0. || angle > 180. || max_bytes == 0 {
        return Err(BrowserError::InvalidLimits);
    }
    Ok(())
}

fn next_identity() -> Result<u64, BrowserError> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| v.checked_add(1))
        .map_err(|_| BrowserError::Exhausted)
}

/// Format 1 (ordered planar region) staged sweep, adapter capability bit 0.
const SWEEP_REGION_BIT: u32 = 1;
/// Format 2 (open rational-path solid disk) staged sweep, capability bit 1.
const SWEEP_DISK_BIT: u32 = 2;

/// Which retained families this exact Worker incarnation can execute now.
/// A capability bit says the adapter implements a format; only this
/// incarnation's own witnesses open the curved families.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserCapabilities {
    pub incarnation: u64,
    pub sdk_bits: u32,
    pub rectangle: bool,
    pub ordered_region: bool,
    pub rational_disk: bool,
}
impl BrowserCapabilities {
    fn select(incarnation: u64, sdk_bits: u32, regions_qualified: bool, disks_qualified: bool) -> Self {
        let region = sdk_bits & SWEEP_REGION_BIT != 0;
        Self {
            incarnation,
            sdk_bits,
            rectangle: region,
            ordered_region: region && regions_qualified,
            rational_disk: sdk_bits & SWEEP_DISK_BIT != 0 && disks_qualified,
        }
    }
    /// Whether `family` is executable on this incarnation.
    pub fn admits(&self, family: ifc_lite_geometry::document::RegionQualification) -> bool {
        use ifc_lite_geometry::document::RegionQualification as Family;
        match family {
            Family::Rectangle => self.rectangle,
            Family::OrderedRegion => self.ordered_region,
            Family::RationalDisk => self.rational_disk,
            _ => false,
        }
    }
}

struct Owner {
    identity: u64,
    live: AtomicBool,
    #[cfg(target_arch = "wasm32")]
    driver: bridge::Driver,
}
impl Owner {
    fn validate(&self) -> Result<(), BrowserError> {
        if !self.live.load(Ordering::Acquire) {
            return Err(BrowserError::WrongWorker);
        }
        #[cfg(target_arch = "wasm32")]
        if !self.driver.live() {
            return Err(BrowserError::WrongWorker);
        }
        Ok(())
    }
    fn retire(&self) {
        if self.live.swap(false, Ordering::AcqRel) {
            #[cfg(target_arch = "wasm32")]
            self.driver.retire();
        }
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.retire();
    }
}

/// Captures one actual module Worker and its private SDK session.
pub struct BrowserWorker {
    owner: Arc<Owner>,
    regions_qualified: bool,
    disks_qualified: bool,
}

/// Retirement captured independently of an executor's async borrow. It cannot
/// create receipts, replace the Worker or grant qualification.
#[derive(Clone)]
pub struct BrowserCancellation {
    owner: Arc<Owner>,
}
impl BrowserCancellation {
    /// The captured incarnation while it and its actual Worker are live.
    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub fn incarnation(&self) -> Option<u64> {
        self.owner.validate().ok().map(|()| self.owner.identity)
    }
    #[cfg(test)]
    pub fn same_worker(&self, worker: &BrowserWorker) -> bool {
        Arc::ptr_eq(&self.owner, &worker.owner)
    }
    pub fn retire(&self) {
        self.owner.retire();
    }
}

impl BrowserWorker {
    pub fn cancellation(&self) -> BrowserCancellation {
        BrowserCancellation {
            owner: self.owner.clone(),
        }
    }
    /// Nonzero while this exact Worker is live; requests are prepared for it.
    pub fn incarnation(&self) -> u64 {
        if self.owner.validate().is_ok() {
            self.owner.identity
        } else {
            0
        }
    }
    pub fn retire(&self) {
        self.owner.retire();
    }
}
impl Drop for BrowserWorker {
    fn drop(&mut self) {
        self.retire();
    }
}

/// One evaluated retained source and the Worker object lease behind it. The
/// completion is immutable and cannot be replaced by host-created geometry.
/// Dropping it releases only its own object before the Worker's next command.
pub struct BrowserRealization {
    #[cfg(target_arch = "wasm32")]
    domain: BrowserCancellation,
    completion: ifc_lite_geometry::document::RetainedCompletion,
    owner: Arc<Owner>,
    object_live: AtomicBool,
    #[cfg(target_arch = "wasm32")]
    object: wasm_bindgen::JsValue,
}
impl BrowserRealization {
    pub fn completion(&self) -> &ifc_lite_geometry::document::RetainedCompletion {
        &self.completion
    }
    pub fn incarnation(&self) -> u64 {
        self.owner.identity
    }
    #[cfg(test)]
    pub fn belongs_to(&self, worker: &BrowserWorker) -> bool {
        Arc::ptr_eq(&self.owner, &worker.owner)
    }
    /// The producing Worker is live and still holds this exact object.
    pub fn validate_live(&self) -> Result<(), BrowserError> {
        self.owner.validate()?;
        if !self.object_live.load(Ordering::Acquire) {
            return Err(BrowserError::WrongWorker);
        }
        #[cfg(target_arch = "wasm32")]
        if !self.owner.driver.object_live(&self.object) {
            return Err(BrowserError::WrongWorker);
        }
        Ok(())
    }
}
impl Drop for BrowserRealization {
    fn drop(&mut self) {
        // Invalidate before the asynchronous release is queued.
        self.object_live.store(false, Ordering::Release);
        #[cfg(target_arch = "wasm32")]
        self.owner.driver.release_object(&self.object);
    }
}

/// Armed before the first await. A dropped Rust future cannot leave its JS
/// Promise allocating in an unowned Worker: it retires the captured owner.
struct InFlight {
    owner: Arc<Owner>,
    armed: bool,
}
impl InFlight {
    fn new(owner: &Arc<Owner>) -> Self {
        Self {
            owner: owner.clone(),
            armed: true,
        }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}
impl Drop for InFlight {
    fn drop(&mut self) {
        if self.armed {
            self.owner.retire();
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
