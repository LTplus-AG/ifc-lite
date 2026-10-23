// SPDX-License-Identifier: MPL-2.0
//! Cache-independent product admission before any root executes (#7781).
use super::ProductControl;
use crate::representation::{product_budget::ProductItems, product_shape};
use crate::{GeometryRouter, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

impl ProductControl<'_> {
    pub(super) fn admit_shape(&self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> Result<Option<ProductItems>> {
        // Retain the missing-shape fast path and its unplaced empty output.
        crate::resource::check_current()?;
        let shape = crate::resource::observe(product_shape(self.element, decoder).map_err(Into::into))?;
        if shape.is_none() { return Ok(None); }
        router.admitted_product(self.element, decoder, self.allowance).map(Some)
    }

    pub(super) fn admit_items(&mut self, index: usize, router: &GeometryRouter,
        decoder: &EntityDecoder) -> Result<Vec<DecodedEntity>> {
        let plan = self.shape.as_mut()
            .ok_or_else(|| crate::Error::geometry("product admission missing"))?;
        plan.validate(router, decoder)?;
        let (_, items) = plan.representations.get_mut(index)
            .ok_or_else(|| crate::Error::geometry("product admission representation missing"))?;
        Ok(std::mem::take(items))
    }
}
