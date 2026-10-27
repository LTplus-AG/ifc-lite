// SPDX-License-Identifier: MPL-2.0
//! Owned numerical constructors admitted by the actual selected processor, and
//! the common item/cache/mapping controller that drives them for a reached item.

pub(crate) mod constructor;
mod boolean;
mod execute;
mod inner;
// Refs #7955: first cross-crate consumer.
// Keep the construction-only surface private until that consumer is reviewed.
#[cfg_attr(any(not(test), not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))), allow(dead_code))]
mod retained;
mod inner_cache;
mod item;
mod layers;
mod mapping;
mod opening;
mod opening_bounds;
mod product;
mod styled;
mod voids;
pub(crate) mod openings;
pub(crate) use boolean::BooleanMachine;
pub(crate) use inner::GeometryProgram;
#[cfg(test)]
pub(crate) use inner::{ProgramError, ProgramStage};

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
mod constructor_tests;

/// Opaque bridge for the off-by-default retained processing executor.
#[doc(hidden)]
#[cfg(feature = "retained-runtime")]
pub mod transactions;
