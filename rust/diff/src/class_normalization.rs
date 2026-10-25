// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Boundary-supplied Unicode normalization, scoped to one pure comparison.
//!
//! Native callers keep Rust's Unicode tables. A host with different tables can
//! prepare lossless mappings BEFORE entering this scope; no host callback is
//! stored or invoked here. ASCII normalization is identical across versions.
use crate::JsString;
use std::{cell::RefCell, collections::HashMap};

thread_local! {
    static OVERRIDES: RefCell<Option<HashMap<JsString, JsString>>> = const { RefCell::new(None) };
}

struct Restore(Option<HashMap<JsString, JsString>>);
impl Drop for Restore {
    fn drop(&mut self) {
        OVERRIDES.with(|slot| { slot.replace(self.0.take()); });
    }
}

/// Run a pure comparison with precomputed host trim/uppercase results (#8042).
/// The previous context is restored on return, error or native unwind, including
/// nested calls. Convert results back to host values AFTER this function returns.
/// Mappings must come from idempotent standard string intrinsics, not callbacks
/// whose return values depend on observation order or invocation count.
pub fn with_overrides<T>(mut mappings: HashMap<JsString, JsString>, compare: impl FnOnce() -> T) -> T {
    // Some passes normalize family keys again. A host that leaves a newly
    // assigned lowercase scalar unchanged must never fall through to Rust's
    // newer table on that second normalization.
    for normalized in mappings.values().cloned().collect::<Vec<_>>() {
        mappings.entry(normalized.clone()).or_insert(normalized);
    }
    let previous = OVERRIDES.with(|slot| slot.replace(Some(mappings)));
    let _restore = Restore(previous);
    compare()
}

pub(crate) fn lookup(value: &JsString) -> Option<JsString> {
    // Ordinary IFC classes incur neither a TLS lookup nor a host intrinsic call.
    if value.units().iter().all(|unit| *unit <= 0x7f) { return None; }
    OVERRIDES.with(|slot| slot.borrow().as_ref().and_then(|map| map.get(value)).cloned())
}

#[cfg(test)]
#[path = "class_normalization_tests.rs"]
mod tests;
