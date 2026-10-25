// SPDX-License-Identifier: MPL-2.0
//! Private retained source authentication; the borrowed public API stays unchanged.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RetainedContextError {
    StaleSource,
    MissingSource,
    MismatchedSource,
}

impl ProductionModel {
    pub(super) fn from_source(source: Arc<ifc_lite_core::SourceBundle>) -> Self {
        Self { source: Some(source), ..Self::new() }
    }
}

impl OwnedMeshProductionContext {
    pub(super) fn validate_decoder(
        &self,
        decoder: &ifc_lite_core::EntityDecoder<'_>,
    ) -> Result<(), RetainedContextError> {
        self.validate_source().map_err(|_| RetainedContextError::StaleSource)?;
        let source = self.source.as_ref().ok_or(RetainedContextError::MissingSource)?;
        if !source.owns_decoder(decoder) {
            return Err(RetainedContextError::MismatchedSource);
        }
        Ok(())
    }

    pub(super) fn lifecycle(&self) -> ProductionLifecycle {
        ProductionLifecycle { id: self.id, state: self.state.clone() }
    }
}

#[derive(Clone)]
pub(super) struct ProductionLifecycle {
    id: ProductionContextId,
    state: Arc<ModelState>,
}
impl ProductionLifecycle {
    pub(super) fn validate(&self) -> Result<(), RetainedContextError> {
        if self.id.source_epoch != self.state.source_epoch.load(Ordering::Acquire) {
            return Err(RetainedContextError::StaleSource);
        }
        Ok(())
    }
    pub(super) fn epoch_revision(&self) -> (u64, u64) {
        (self.id.source_epoch, self.id.revision)
    }
}

#[cfg(test)]
#[path = "model_context_retained_tests.rs"]
mod tests;
