// SPDX-License-Identifier: MPL-2.0
//! Scoped E2 fixture injection, compiled only for wasm32 tests.
use super::super::{bridge::driver_error, next_identity, BrowserWorker, Owner};
use ifc_lite_processing::element::retained_runtime::RuntimeFault;
use std::{cell::RefCell, sync::{atomic::AtomicBool, Arc}};
use wasm_bindgen::{JsCast, JsValue};

thread_local! {
    static FACTORY: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// The real public API and all replacements use this driver only while the
/// guard lives. Actual-SDK tests in the same binary retain the normal path.
pub(crate) struct TestDriver;
impl TestDriver {
    pub(crate) fn install(factory: JsValue) -> Self {
        let factory = factory.dyn_into::<js_sys::Function>().expect("driver factory");
        FACTORY.with_borrow_mut(|slot| {
            assert!(slot.is_none(), "nested test driver");
            *slot = Some(factory);
        });
        Self
    }
}
impl Drop for TestDriver {
    fn drop(&mut self) {
        FACTORY.with_borrow_mut(|slot| *slot = None);
    }
}

pub(super) fn worker() -> Result<Option<BrowserWorker>, RuntimeFault> {
    FACTORY.with_borrow(|slot| {
        let Some(factory) = slot else { return Ok(None) };
        let driver = factory.call0(&JsValue::UNDEFINED).map_err(driver_error)?;
        Ok(Some(BrowserWorker {
            owner: Arc::new(Owner {
                identity: next_identity()?,
                live: AtomicBool::new(true),
                driver: driver.unchecked_into(),
            }),
            regions_qualified: false,
            disks_qualified: false,
        }))
    })
}
