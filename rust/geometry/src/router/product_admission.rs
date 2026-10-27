// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Private product admission/report boundary; no rendering or cache ownership.
use super::GeometryRouter;
#[cfg(test)]
use crate::representation::product_budget::admit_product;
use crate::representation::{product_budget::ProductItems, WalkRefusal};
use crate::Result;
#[cfg(test)]
use ifc_lite_core::EntityDecoder;

impl GeometryRouter {
    pub(crate) fn report_product_admission(&self, plan: &ProductItems) -> Result<()> {
        if let Some((item, WalkRefusal::Budget { max_levels })) = plan.refusal.as_deref() {
            // A product refusal belongs to this request, even beneath a caller's
            // source suppression scope. No source/template claim is made here.
            crate::resource::check_current()?;
            let _policy = self.enter_unsupported_policy(true);
            self.record_unsupported_item(item.ifc_type.clone());
            let _error = WalkRefusal::Budget {
                max_levels: *max_levels,
            }
            .into_error(item.id);
            crate::diag::diag_debug!(
                { item_id = item.id, ifc_type = ?item.ifc_type, error = %_error,
                  "product logical admission withheld a root" }
                else {
                    #[cfg(debug_assertions)]
                    eprintln!("[ifc-lite] Product admission refused #{} ({}): {}",
                        item.id, item.ifc_type, _error);
                }
            );
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "product_admission_tests.rs"]
mod tests;
