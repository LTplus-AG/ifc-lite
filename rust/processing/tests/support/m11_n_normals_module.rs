// SPDX-License-Identifier: MPL-2.0
use super::{OwnedResourceContext, Requirement, ShapePart, Storage};
pub(super) struct ShapeOnlyProduct { parts: Vec<ShapePart>, _storage: Storage }
pub(super) struct Context<'a> { resources: &'a OwnedResourceContext, angle_degrees: f64 }
#[path = "../../src/element/session_retained/presentation/face_attribution.rs"]
mod face_attribution;
#[path = "../../src/element/session_retained/presentation/face_coincidence.rs"]
mod face_coincidence;
#[path = "../../src/element/session_retained/presentation/face_curve.rs"]
mod face_curve;
#[path = "m11_n_mesh_module.rs"]
mod normals;
