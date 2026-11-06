// SPDX-License-Identifier: MPL-2.0
//! Relationship cuts are a production input, independent of authored booleans.
use super::IfcAPI;
use std::sync::atomic::Ordering;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Generate gross hosts by skipping IfcRelVoidsElement subtraction only.
    /// Defaults to false. Set before processing; existing meshes are unchanged.
    #[wasm_bindgen(js_name = setSkipVoids)]
    pub fn set_skip_voids(&self, on: bool) {
        self.skip_voids.store(on, Ordering::Relaxed);
    }
}

impl IfcAPI {
    pub(crate) fn skip_voids(&self) -> bool {
        self.skip_voids.load(Ordering::Relaxed)
    }
}
