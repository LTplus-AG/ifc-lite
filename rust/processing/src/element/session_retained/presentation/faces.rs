// SPDX-License-Identifier: MPL-2.0
//! M11 faces seam: no presentation authority yet.
use super::{ShapeOnlyProduct, RetainedProductPlan, Requirement};
pub(super) fn apply(_product: &mut ShapeOnlyProduct, _context: &RetainedProductPlan) -> Vec<Requirement> {
    Vec::new()
}
