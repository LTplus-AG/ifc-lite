// SPDX-License-Identifier: MPL-2.0
//! Logical product admission before any root executes, independent of caches.
use super::{retained_structure, ProductControl, ProductItems};
use crate::{GeometryRouter, Result};
use ifc_lite_core::EntityDecoder;

impl ProductControl<'_> {
    pub(super) fn admit(
        &self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> Result<ProductItems> {
        crate::resource::check_current()?;
        if let Some(selection) = &self.retained {
            // Retained completeness remains stricter than the ordinary mesh walk.
            retained_structure::validated_product_shape(self.element, decoder)
                .map_err(|error| error.into_common(selection))?;
        }
        let mut plan = crate::representation::product_budget::admit_product(
            self.element,
            decoder,
            self.allowance,
            router,
        );
        plan.strict()?;
        plan.validate(router, decoder)?;
        // Retained output is complete-or-refused, never a partial exact success.
        if self.retained.is_some() {
            if let Some((item, why)) = plan.refusal.take() {
                return Err(why.into_error(item.id));
            }
        }
        Ok(plan)
    }

    #[cfg(test)]
    pub(in crate::program) fn with_logical_limit(mut self, allowance: u32) -> Self {
        self.allowance = allowance;
        self
    }
}
