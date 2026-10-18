// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! BRep/surface model processors.
//!
//! Handles IfcFacetedBrep, IfcFaceBasedSurfaceModel, and IfcShellBasedSurfaceModel.
//! All deal with boundary representations composed of face loops.

mod faceted;
pub(crate) mod faceted_plan;
mod surface_model;

#[cfg(test)]
mod planar_tests;

pub use faceted::FacetedBrepProcessor;
pub(crate) use surface_model::SurfaceModelPlan;
pub use surface_model::{FaceBasedSurfaceModelProcessor, ShellBasedSurfaceModelProcessor};
