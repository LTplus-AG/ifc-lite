// SPDX-License-Identifier: MPL-2.0
//! Reached product representation control and owned numerical operations.
//!
//! Owns the five reached representation/item policies, mapping child frames,
//! boolean continuations, material-layer admission/slicing, and host-opening
//! classification and owned numerical execution. These synchronous seams claim
//! no transport authentication or complete resource envelope.

pub(crate) mod openings;
mod traversal;
pub(crate) mod boolean;
pub(crate) mod layers;
pub(crate) mod product_control;
pub(crate) mod opening;
mod opening_bounds;
pub(crate) mod mapping;
pub(crate) mod type_map;
pub(crate) mod annotation;
pub(crate) mod constructor;
mod execute;
mod item;
mod inner;
mod inner_ready;
mod retained;
mod retained_clip;
pub use retained_clip::{RetainedPlaneCoefficients, RetainedPlaneSource, RetainedUnaryClip, RetainedClipMode};
mod retained_entries;
mod retained_presentation;
pub use retained_presentation::RetainedPresentation;
mod retained_walk;
pub use retained::{RetainedContract, LogicalRetainedDefinition, LogicalRetainedSlot, LogicalRetainedValue, RetainedPlanOperation, RetainedOperationKind, RetainedProductPlan, RetainedRequirement, RetainedPlacement, RetainedPlacementStage};
pub(crate) use inner_ready::ReadyOperation;
mod inner_boolean;
mod inner_cache;
mod inner_mapping;
mod inner_product;
mod inner_product_adapter;
mod inner_product_prelude;
mod inner_type_map;
mod inner_cancel;
mod inner_layers;
mod inner_voids;
mod inner_entries;
mod inner_opening;
pub use inner::{GeometryProgram, ProgramRequest, ProgramReply, ProgramError, RejectedProgramReply};
mod resources;
mod source;
pub(crate) use source::{ItemListPolicy, ItemProgram};
pub(crate) use traversal::{EntryPolicy, ProductProgram};

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
    #[cfg(test)]
    pub(crate) fn evaluate(self, texture: &crate::ResolvedTextureMap) -> (crate::Mesh, Vec<f32>) {
        self.0.evaluate_with_texture(texture)
    }
    pub(crate) fn evaluate_coordinates(self, coordinates: &[[f32; 2]], indices: Option<Vec<[u32; 3]>>)
        -> (crate::Mesh, Vec<f32>) {
        self.0.evaluate_with_uvs(coordinates, indices)
    }
}

#[cfg(test)]
mod policy_tests;

#[cfg(test)]
mod inner_unwind_tests;

#[cfg(test)]
mod retained_tests;

#[cfg(test)]
mod retained_mapping_tests;

#[cfg(test)]
mod retained_styled_tests;

#[cfg(test)]
mod retained_operation_tests;

#[cfg(test)]
mod retained_walk_tests;

#[cfg(test)]
mod retained_clip_tests;
