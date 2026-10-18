// SPDX-License-Identifier: MPL-2.0
//! Reached product representation control and owned numerical operations.
//!
//! Owns the five reached representation/item policies, mapping child frames,
//! boolean continuations and material-layer admission/slicing. Opening
//! classification retains its existing owner. These synchronous seams claim
//! no transport authentication or complete resource envelope.

mod traversal;
mod boolean;
pub(crate) mod layers;
mod product;
pub(crate) mod opening;
mod opening_bounds;
pub(crate) mod mapping;
pub(crate) mod type_map;
pub(crate) mod annotation;
pub(crate) mod constructor;
mod execute;
mod resources;
mod source;
pub(crate) use source::{ItemListPolicy, ItemProgram};
pub(crate) use traversal::{EntryPolicy, ProductProgram, ReachedItem};

/// Opaque, owned constructor admitted by the actual selected processor instance.
/// It contains sampled production parameters in file units, never a decoder,
/// source callback, product placement or a finished-mesh substitute for source.
#[derive(Debug, Clone)]
pub struct OwnedConstructor(constructor::Constructor);

impl OwnedConstructor {
    pub(crate) fn new(value: constructor::Constructor) -> Self { Self(value) }

    pub(crate) fn restore_source_reports(&self) {
        if let constructor::Constructor::SurfaceModel(plan) = &self.0 {
            crate::processors::diagnostic_capture::restore(&plan.source_reports());
        }
    }

    /// Evaluate without access to IFC source or a geometry router.
    pub fn evaluate(self) -> crate::Result<crate::Mesh> {
        execute::construct(self)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod constructor_tests;

/// Owned geometry side of the texture attempt. The immutable resolved texture
/// index is an execution input, never a decoder/source callback. An unsuccessful
/// attempt retains the caller's historical plain-geometry recovery.
pub(crate) struct TextureConstructor(crate::processors::triangulated_plan::TriangulatedFaceSetPlan);
impl TextureConstructor {
    pub(crate) fn admit(item: &ifc_lite_core::DecodedEntity, decoder: &mut ifc_lite_core::EntityDecoder<'_>, rtc: Option<(f64, f64, f64)>) -> crate::Result<Self> {
        crate::processors::triangulated_plan::lower(item, decoder, rtc).map(Self)
    }
    pub(crate) fn evaluate(self, texture: &crate::ResolvedTextureMap) -> (crate::Mesh, Vec<f32>) {
        self.0.evaluate_with_texture(texture)
    }
}

#[cfg(test)]
mod policy_tests;
