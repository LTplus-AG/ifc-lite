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
    pub(crate) fn report_product_admission(&self, plan: &ProductItems, product: &ifc_lite_core::DecodedEntity) -> Result<()> {
        if let Some((item, WalkRefusal::Budget { max_levels, details, .. })) = plan.refusal.as_deref() {
            crate::resource::check_current()?;
            self.record_budget_refusal(item.id, details.budget(), *max_levels, details.reached(), Some(product));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "product_admission_tests.rs"]
mod tests;
