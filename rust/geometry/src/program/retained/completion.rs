// SPDX-License-Identifier: MPL-2.0
//! Consumed completion retains the traversal's original failure and stop domain.
use super::*;
type Completion<T> = std::result::Result<T, RetainedFailure>;

impl RetainedProgram<'_> {
    pub(in crate::program) fn finish(self) -> Completion<RetainedProductPlan> {
        self.check()?;
        let failure = self.completion_handle()?;
        match self.finish_retained_output(&failure, FailureSite::ProductCompletion)? {
            Output::Product(ProductOutput::Retained(values, selection)) => {
                if !values.iter().all(|v| v.is_product_placed()) {
                    return Err(RetainedFailure::Completion(CompletionReason::ProductPlacementMissing));
                }
                let _ = selection.program();
                Ok(RetainedProductPlan {
                    values,
                    // Construction/placement discharge none of these obligations.
                    remaining: vec![RetainedRequirement::OpeningClosure,
                        RetainedRequirement::MaterialLayers, RetainedRequirement::IfcAppearance,
                        RetainedRequirement::PersistentFaces],
                })
            }
            _ => Err(RetainedFailure::Completion(CompletionReason::WrongOutputKind)),
        }
    }
    pub(in crate::program) fn finish_type_map(self, type_product: u32, class: u8, color: [f32; 4])
        -> Completion<RetainedProductPlan> {
        self.check()?;
        // Clone before consuming inner, and keep it through presentation allocation.
        let failure = self.completion_handle()?;
        let map = match &self.inner.control {
            Control::Mapping(control) => control.representation_map_id(),
            _ => None,
        }.ok_or(RetainedFailure::Completion(CompletionReason::TypeMapRootMissing))?;
        if color.iter().any(|component| !component.is_finite()) {
            return Err(RetainedFailure::Completion(CompletionReason::NonfiniteTypeColor));
        }
        match self.finish_retained_output(&failure, FailureSite::TypeMapCompletion)? {
            Output::Mapping(crate::program::mapping::MappingOutput::Retained(mut values)) => {
                for value in &mut values {
                    let mut binding = RetainedPresentation::occurrence(type_product, map, None, true);
                    binding.type_product = Some((type_product, class));
                    binding.fallback_color = Some(color);
                    value.present(binding).map_err(|error| failure.common(FailureSite::TypeBinding, error))?;
                }
                if let Some(error) = failure.reported() { return Err(error); }
                Ok(RetainedProductPlan {
                    values,
                    remaining: vec![RetainedRequirement::ProductPlacement,
                        RetainedRequirement::OpeningClosure, RetainedRequirement::MaterialLayers,
                        RetainedRequirement::IfcAppearance, RetainedRequirement::PersistentFaces],
                })
            }
            _ => Err(RetainedFailure::Completion(CompletionReason::WrongOutputKind)),
        }
    }
    fn completion_handle(&self) -> Completion<FailureHandle> {
        self.selection().map(RetainedSelection::failure_handle)
            .ok_or(RetainedFailure::Protocol(RetainedProgramError::Unsupported))
    }
    fn finish_retained_output(self, failure: &FailureHandle, site: FailureSite) -> Completion<Output> {
        if let Some((_, executed)) = self.inner.pending {
            return Err(RetainedFailure::Completion(if executed {
                CompletionReason::UnacceptedReply
            } else { CompletionReason::UnexecutedRequest }));
        }
        let stage = match &self.inner.control {
            Control::Product(control) => control.stage(),
            Control::Mapping(control) => control.stage(),
            _ => return Err(RetainedFailure::Completion(CompletionReason::WrongOutputKind)),
        }.map_err(|error| RetainedFailure::Protocol(error.into()))?;
        if stage.is_some() { return Err(RetainedFailure::Completion(CompletionReason::Incomplete)); }
        let output = self.inner.finish_output().map_err(|error| failure.common(site, error))?;
        // A later completed sibling cannot erase an earlier traversal refusal.
        if let Some(error) = failure.reported() { return Err(error); }
        Ok(output)
    }
}
