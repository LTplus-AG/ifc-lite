// SPDX-License-Identifier: MPL-2.0
//! Private retained source authentication; the borrowed public API stays unchanged.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetainedContextError {
    Stale,
    Missing,
    Mismatched,
}

impl ProductionModel {
    pub(in crate::element) fn from_source(source: Arc<ifc_lite_core::SourceBundle>) -> Self {
        Self { source: Some(source), ..Self::new() }
    }
}

impl OwnedMeshProductionContext {
    #[cfg(feature = "retained-runtime")]
    pub(in crate::element) fn source(&self) -> Option<&Arc<ifc_lite_core::SourceBundle>> { self.source.as_ref() }
    pub(in crate::element) fn validate_decoder(
        &self,
        decoder: &ifc_lite_core::EntityDecoder<'_>,
    ) -> Result<(), RetainedContextError> {
        self.validate_source().map_err(|_| RetainedContextError::Stale)?;
        let source = self.source.as_ref().ok_or(RetainedContextError::Missing)?;
        if !source.owns_decoder(decoder) {
            return Err(RetainedContextError::Mismatched);
        }
        Ok(())
    }

    pub(in crate::element) fn lifecycle(&self) -> ProductionLifecycle {
        ProductionLifecycle { id: self.id, state: self.state.clone() }
    }
}

#[derive(Clone)]
pub(in crate::element) struct ProductionLifecycle {
    id: ProductionContextId,
    state: Arc<ModelState>,
}
impl ProductionLifecycle {
    pub(in crate::element) fn validate(&self) -> Result<(), RetainedContextError> {
        if self.id.source_epoch != self.state.source_epoch.load(Ordering::Acquire) {
            return Err(RetainedContextError::Stale);
        }
        Ok(())
    }
    pub(in crate::element) fn epoch_revision(&self) -> (u64, u64) {
        (self.id.source_epoch, self.id.revision)
    }
}

#[cfg(test)]
#[path = "model_context_retained_tests.rs"]
mod tests;
