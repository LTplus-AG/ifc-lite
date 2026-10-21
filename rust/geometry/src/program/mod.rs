// SPDX-License-Identifier: MPL-2.0
//! Owned numerical constructors admitted by the actual selected processor, and
//! the common item/cache/mapping controller that drives them for a reached item.

pub(crate) mod constructor;
mod execute;
mod inner;
mod inner_cache;
mod item;
mod mapping;
pub(crate) mod mapping_budget;
mod opening;
mod opening_bounds;
pub(crate) mod openings;
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
