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
//! Crate-private: the JavaScript host contract (`api::retained_browser`) is
//! its only consumer. Until that contract lands in the next stacked slice the
//! executor is reached by its own actual-Worker tests alone, hence the allow.
#![allow(dead_code)]
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

#[cfg(target_arch = "wasm32")]
mod bridge;

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
    /// The driver, transport or SDK refused or failed (message preserved).
    Driver(String),
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongWorker => write!(f, "browser worker retired or foreign"),
            Self::InvalidLimits => write!(f, "invalid retained evaluation limits"),
            Self::Unqualified(message) => write!(f, "unqualified retained request: {message}"),
            Self::Exhausted => write!(f, "browser incarnation exhausted"),
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
    pub fn incarnation(&self) -> Option<u64> {
        self.owner.validate().ok().map(|()| self.owner.identity)
    }
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
