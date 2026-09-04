// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Split out of `router/diagnostics.rs` (module-size ratchet): the sweep that
//! moves a processor's OWN boolean-failure log into the router's map, so
//! `take_csg_failures` is the single drain point every pipeline already calls.

use super::super::GeometryRouter;
use super::UNATTRIBUTED_PRODUCT_ID;
use crate::BoolFailure;

impl GeometryRouter {
    /// Sweep every registered processor's own boolean-failure log into this
    /// router's map. Called by [`Self::take_csg_failures`], so a consumer that
    /// already drains the router — the native pipeline via
    /// `produce_element_meshes`, the wasm batch path via
    /// `drain_and_log_csg_diagnostics` — picks these up with no second opt-in.
    ///
    /// Before #3821 `BooleanClippingProcessor::take_failures` was called from
    /// tests ONLY. Everything the boolean processor recorded (an unsupported
    /// operand, an `EmptyOperand` cutter, an unknown operator) accumulated in a
    /// `RefCell` no production caller ever read, so a model whose booleans all
    /// degraded still reported a clean load: absence was indistinguishable from
    /// success.
    ///
    /// Bucketed under [`UNATTRIBUTED_PRODUCT_ID`] — the same "no attribution
    /// available" bucket `take_csg_failures` already uses for
    /// `PENDING_MAPPED_BOOL_FAILURES`. A processor is registered once per
    /// router and reused across every item it meshes, so at drain time its log
    /// is not attributable to one product from in here.
    ///
    /// What that bucket does and does NOT preserve, precisely: the native and
    /// wasm pipelines both drain PER ELEMENT (`produce_element_meshes` takes
    /// the router's failures after each job), so a record can never be
    /// mis-attributed to a DIFFERENT element — it is attributed to none. The
    /// element it came from is lost, so these records do not appear in the
    /// per-product `worst_hosts` detail and are excluded from
    /// `products_with_failures` (see [`super::count_attributed_products`]);
    /// they do count towards the failure totals and the reason breakdown.
    /// Real per-product attribution would mean threading the owning product id
    /// down to every `processor.process` call site; that is a follow-up, not a
    /// reason to keep dropping the records.
    ///
    /// `register` stores ONE `Arc` per processor under each supported IFC type
    /// (`IfcBooleanResult` and `IfcBooleanClippingResult` share an instance),
    /// so iterating the map visits the same processor twice; the second visit
    /// drains an already-emptied log and contributes nothing. No double count.
    pub fn drain_processor_failures(&self) {
        let mut swept: Vec<BoolFailure> = Vec::new();
        for processor in self.processors.values() {
            swept.extend(processor.take_bool_failures());
        }
        if !swept.is_empty() {
            self.csg_failures
                .borrow_mut()
                .entry(UNATTRIBUTED_PRODUCT_ID)
                .or_default()
                .extend(swept);
        }
    }
}
