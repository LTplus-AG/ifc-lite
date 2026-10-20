// SPDX-License-Identifier: MPL-2.0
//! Numerical entry: no decoder or router service can enter construction.
use super::{OwnedConstructor, constructor::Constructor};
use crate::{Mesh, Result};

pub(super) fn construct(plan: OwnedConstructor) -> Result<Mesh> {
    let mesh = match plan.0 {
        Constructor::Empty => Ok(Mesh::new()),
        Constructor::Extrusion(plan) => plan.evaluate(),
        Constructor::TaperedExtrusion(plan) => plan.evaluate(),
        Constructor::Revolved(plan) => plan.evaluate(),
        Constructor::SweptDisk(plan) => Ok(plan.evaluate()),
        Constructor::SweptArea(plan) => plan.evaluate(),
        Constructor::Block(plan) => Ok(plan.evaluate()),
        Constructor::Sphere(plan) => Ok(plan.evaluate()),
        Constructor::Triangles(plan) => Ok(plan.evaluate()),
        Constructor::Polygons(plan) => Ok(plan.evaluate()),
        Constructor::FacetedBrep(plan) => Ok(plan.evaluate()),
        Constructor::SectionedSolid(plan) => plan.evaluate(),
        Constructor::AdvancedBrep(plan) => plan.evaluate(),
        Constructor::BSplineSurface(plan) => plan.evaluate(),
        Constructor::SurfaceModel(plan) => plan.evaluate(),
        Constructor::Alignment(plan) => Ok(plan.evaluate()),
        Constructor::Edge(plan) => Ok(plan.evaluate()),
        Constructor::FaceSurface(plan) => plan.evaluate(),
        Constructor::LinearExtrusionSurface(plan) => Ok(plan.evaluate()),
    }?;
    Ok(mesh)
}
