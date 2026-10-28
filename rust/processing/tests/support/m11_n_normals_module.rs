// SPDX-License-Identifier: MPL-2.0
use super::{OwnedResourceContext, Requirement, ShapePart, Storage};
pub(super) struct ShapeOnlyProduct { parts: Vec<ShapePart>, _storage: Storage }
pub(super) struct Context<'a> { resources: &'a OwnedResourceContext }
#[path = "../../src/element/session_retained/presentation/normals.rs"]
mod normals;
