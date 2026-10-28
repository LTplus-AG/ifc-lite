// SPDX-License-Identifier: MPL-2.0
//! M11 slice seams. Only a slice with its own proof may discharge an obligation.
use super::{publication::ShapeOnlyProduct, RetainedProductPlan};
use ifc_lite_geometry::program::transactions::Requirement;
mod appearance;
mod normals;
mod faces;
mod instancing;

pub(super) fn apply(product: &mut ShapeOnlyProduct, context: &RetainedProductPlan) -> Vec<Requirement> {
    let mut discharged = Vec::new();
    discharged.extend(appearance::apply(product, context));
    discharged.extend(normals::apply(product, context));
    discharged.extend(faces::apply(product, context));
    discharged.extend(instancing::apply(product, context));
    discharged
}
