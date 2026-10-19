// SPDX-License-Identifier: MPL-2.0
//! Target-neutral identity/lease store for the private browser executor.
//! Numeric incarnation fields are bookkeeping, never constructors of authority.
use ifc_lite_geometry::document::{RetainedCompletion, RetainedRefusal};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[cfg(target_arch = "wasm32")]
#[path = "browser_bridge.rs"]
mod bridge;
#[path = "browser_dependencies.rs"]
mod dependencies;
pub use dependencies::{BrowserDependency, BrowserDependencyResult, BrowserOperationIdentity, BrowserObjectHandle};

#[cfg(target_arch = "wasm32")]
fn evaluation_limits(chord: f64, angle: f64, max_bytes: u32) -> Result<(), RetainedRefusal> {
    if !chord.is_finite() || chord <= 0. || !angle.is_finite() || angle <= 0. || angle > 180. || max_bytes == 0 {
        return Err(RetainedRefusal::InvalidSource("invalid retained evaluation limits"));
    }
    Ok(())
}

struct Owner {
    identity: u64,
    independent_leases: bool,
    live: AtomicBool,
    #[cfg(target_arch = "wasm32")]
    driver: bridge::Driver,
}
impl Owner {
    fn validate(&self) -> Result<(), RetainedRefusal> {
        if !self.live.load(Ordering::Acquire) {
            return Err(RetainedRefusal::InvalidRuntime);
        }
        #[cfg(target_arch = "wasm32")]
        if !self.driver.live() {
            return Err(RetainedRefusal::InvalidRuntime);
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

/// Captures one actual module Worker. There is no constructor from an integer,
/// a callback, a user transport or a supplied response buffer.
pub struct BrowserWorker {
    owner: Arc<Owner>,
    #[cfg(target_arch = "wasm32")]
    qualified: bool,
}
/// A captured retirement capability independent of an executor's async borrow.
/// It cannot create receipts, replace the worker or grant qualification.
pub struct BrowserCancellation {
    owner: Arc<Owner>,
}
impl BrowserCancellation {
    pub fn retire(&self) {
        self.owner.retire();
    }
}
impl BrowserWorker {
    pub fn cancellation(&self) -> BrowserCancellation {
        BrowserCancellation { owner: self.owner.clone() }
    }
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

#[cfg(any(test, target_arch = "wasm32"))]
fn next_identity() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| v.checked_add(1))
        .expect("browser incarnation exhausted")
}

/// Private store entry. The completion is immutable and cannot be replaced by
/// host-created geometry. Its object lease and Worker must both remain live.
pub struct BrowserRealization {
    completion: RetainedCompletion,
    handle: BrowserObjectHandle,
    owner: Arc<Owner>,
    object_live: Arc<AtomicBool>,
    #[cfg(target_arch = "wasm32")]
    object: wasm_bindgen::JsValue,
}
impl BrowserRealization {
    pub fn handle(&self) -> &BrowserObjectHandle { &self.handle }
    pub fn completion(&self) -> &RetainedCompletion {
        &self.completion
    }
    pub fn incarnation(&self) -> u64 {
        self.owner.identity
    }
    pub fn validate_live(&self) -> Result<(), RetainedRefusal> {
        self.owner.validate()?;
        if !self.object_live.load(Ordering::Acquire) {
            return Err(RetainedRefusal::InvalidRuntime);
        }
        #[cfg(target_arch = "wasm32")]
        if !self.owner.driver.object_live(&self.object) {
            return Err(RetainedRefusal::InvalidRuntime);
        }
        Ok(())
    }
    pub fn retire(&self) {
        self.object_live.store(false, Ordering::Release);
        self.owner.retire();
    }
}
impl Drop for BrowserRealization {
    fn drop(&mut self) {
        self.object_live.store(false, Ordering::Release);
        if self.owner.independent_leases {
            #[cfg(target_arch = "wasm32")]
            self.owner.driver.release_object(&self.object);
        } else { self.owner.retire(); }
    }
}

/// Armed before the first await. A dropped Rust future cannot leave its JS
/// Promise allocating in an unowned Worker. Retirement has captured identity.
#[cfg(any(test, target_arch = "wasm32"))]
struct InFlight {
    owner: Arc<Owner>,
    armed: bool,
}
#[cfg(any(test, target_arch = "wasm32"))]
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
#[cfg(any(test, target_arch = "wasm32"))]
impl Drop for InFlight {
    fn drop(&mut self) {
        if self.armed {
            self.owner.retire();
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "browser_tests.rs"]
mod tests;
