// SPDX-License-Identifier: MPL-2.0
//! M11 normals seam: no presentation authority yet.
use super::{ShapeOnlyProduct, Context, Requirement};
pub(super) fn apply(_product: &mut ShapeOnlyProduct, _context: &Context<'_>) -> Vec<Requirement> {
    Vec::new()
}
