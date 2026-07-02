// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! BRep/surface model processors.
//!
//! Handles IfcFacetedBrep, IfcFaceBasedSurfaceModel, and IfcShellBasedSurfaceModel.
//! All deal with boundary representations composed of face loops.

mod faceted;
mod surface_model;

pub use faceted::FacetedBrepProcessor;
pub use surface_model::{FaceBasedSurfaceModelProcessor, ShellBasedSurfaceModelProcessor};
