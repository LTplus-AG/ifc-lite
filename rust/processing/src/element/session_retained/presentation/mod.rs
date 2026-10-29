// SPDX-License-Identifier: MPL-2.0
//! M11 slice seams. Only a slice with its own proof may discharge an obligation.
use super::{publication::ShapeOnlyProduct, RetainedProductPlan, OwnedMeshProductionContext, OwnedResourceContext, RetainedExecutionError};
use ifc_lite_geometry::program::transactions::Requirement;
mod appearance;
mod normals;
mod faces;
mod face_attribution;
mod face_coincidence;
mod face_curve;
mod face_surfaces;
mod instancing;
pub(super) use faces::{sources as face_sources, FaceSources};

// M11-A/N/F/I consume these immutable inputs in their own modules.
#[allow(dead_code)] // Scaffold inputs become live when the independently gated slices land.
pub(super) struct Context<'a> {
    pub plan: &'a RetainedProductPlan,
    pub model: &'a OwnedMeshProductionContext,
    pub resources: &'a OwnedResourceContext,
    pub element_color: [f32; 4],
    /// M11-F: each part's source operands, in part order.
    pub faces: &'a [FaceSources],
    /// M11-F: the run's evaluation chord, bounding curved incidence.
    pub chord_metres: f64,
    /// The same run limit passed to numerical tessellation.
    pub angle_degrees: f64,
}

pub(super) fn apply(product: &mut ShapeOnlyProduct, context: &Context<'_>) -> Result<Vec<Requirement>, RetainedExecutionError> {
    let mut discharged = Vec::new();
    discharged.extend(appearance::apply(product, context));
    normals::prepare(product, context)?;
    discharged.extend(faces::apply(product, context)?);
    discharged.extend(normals::apply(product, context)?);
    discharged.extend(instancing::apply(product, context));
    Ok(discharged)
}
