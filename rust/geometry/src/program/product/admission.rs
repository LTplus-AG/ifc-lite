// SPDX-License-Identifier: MPL-2.0
//! Logical product admission before any root executes, independent of caches.
use super::{retained_structure, ProductControl, ProductItems};
use crate::{GeometryRouter, Result};
use ifc_lite_core::EntityDecoder;

impl ProductControl<'_> {
    #[inline(always)]
    pub(super) fn admit(
        &self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> Result<ProductItems> {
        let mut plan = if let Some(selection) = &self.retained {
            crate::resource::check_current()?;
            // Strict validation charges all raw root lists before reading their
            // members, including skipped representations. Reuse selected roots.
            let roots =
                retained_structure::validated_product_shape(self.element, decoder, self.allowance)
                    .map_err(|error| error.into_common(selection))?;
            crate::representation::product_budget::admit_retained_product(
                self.element,
                decoder,
                self.allowance,
                router,
                roots,
            )
        } else {
            crate::representation::product_budget::admit_product(
                self.element,
                decoder,
                self.allowance,
                router,
            )
        };
        plan.strict()?;
        // The plan just sealed these owners, with no intervening callback.
        // Execution validates them again before consuming admitted roots.
        // Retained output is complete-or-refused, never a partial exact success.
        if self.retained.is_some() {
            if let Some((item, why)) = plan.refusal.take().map(|failure| *failure) {
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
