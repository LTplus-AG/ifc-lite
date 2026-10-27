// SPDX-License-Identifier: MPL-2.0
//! Recoverable caller faults retain the original armed transaction.
use super::*;
use ifc_lite_geometry::program::transactions::Requirement;

pub(super) struct RuntimeRejectedExecution<R: NumericalReceipt> {
    pub reason: RetainedExecutionError,
    pub issued: Option<RuntimeIssued<R>>,
}
impl<R: NumericalReceipt> std::fmt::Debug for RuntimeRejectedExecution<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeRejectedExecution")
            .field("reason", &self.reason)
            .field("recoverable", &self.issued.is_some())
            .finish()
    }
}
impl<R: NumericalReceipt> std::fmt::Display for RuntimeRejectedExecution<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.reason)
    }
}
impl<R: NumericalReceipt> std::error::Error for RuntimeRejectedExecution<R> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.reason)
    }
}
impl<R: NumericalReceipt> RuntimeRejectedExecution<R> {
    pub(super) fn predispatch(
        reason: RetainedExecutionError,
        issued: RuntimeIssued<R>,
    ) -> Box<Self> {
        Box::new(Self {
            reason,
            issued: Some(issued),
        })
    }
    pub(super) fn terminal(reason: RetainedExecutionError) -> Box<Self> {
        Box::new(Self {
            reason,
            issued: None,
        })
    }
}
impl<R: NumericalReceipt> RuntimeIssued<R> {
    pub(super) fn validate_predispatch_state(&self) -> Result<(), RetainedExecutionError> {
        // The captured resource/source fault precedes caller mistakes and never
        // consults the unrelated ambient execution scope.
        check_resources(&self.resources)?;
        self.lifecycle
            .validate()
            .map_err(RetainedExecutionError::Source)?;
        let stage = self.cancellation.stage.load(Ordering::Acquire);
        if stage != ISSUED {
            return Err(RetainedExecutionError::Transition(stage));
        }
        if self.cancellation.owner.incarnation().is_none() {
            return Err(RetainedExecutionError::DomainRetired);
        }
        Ok(())
    }
}

impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    /// Inspect logical final definitions without manufacturing numerical outcomes.
    /// A separate traversal keeps its source-only cache out of the live executor.
    pub(super) fn refuse_incomplete_shape(
        &mut self,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<(), RetainedExecutionError> {
        let Some(outer) = self.outer else {
            return Ok(());
        };
        let resources = self.resources.clone();
        let result = resources.with_scope(|| self.owner.work(decoder, router, |d, r| {
            self.scopes.with_scope(|| {
                let (epoch, revision) = self.context.lifecycle().epoch_revision();
                let traversal = RetainedTraversal::new(epoch, revision);
                let mut program = match outer.kind {
                    WorkKind::TypeMap { map_id, .. } => traversal.type_map(
                        d.decode_by_id(map_id).map_err(RetainedExecutionError::Core)?,
                        self.context.borrowed().texture_index),
                    WorkKind::PlainParts => traversal.product_parts(self.state.job.entity),
                    _ => traversal.product_submeshes(
                        self.state.job.entity, self.context.borrowed().texture_index),
                };
                let mut affines = Vec::new();
                let mut storage = Storage::default();
                while let Some(ticket) = program.request().map_err(common)? {
                    let (reply, operations, _reservation) = program.admit(ticket, r, d).map_err(common)?;
                    for operation in operations {
                        if matches!(operation.kind(), RetainedOperationKind::Affine { .. }) {
                            storage.reserve(&resources, &mut affines, 1)?;
                            affines.push(operation.value().definition());
                        }
                    }
                    program.accept(reply, r).map_err(|e| common(e.error))?;
                }
                let plan = match outer.kind {
                    WorkKind::TypeMap { class, .. } => program.finish_type_map(
                        self.state.job.id, class, self.state.element_color),
                    _ => program.finish(),
                }.map_err(common)?;
                if plan.requirements().any(|r| r == Requirement::ProductPlacement) {
                    return Err(RetainedExecutionError::Unsupported(
                        Unsupported::RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs));
                }
                for value in plan.values() {
                    resource::charge(resource::Cost { work: affines.len() as u64 + 1, ..Default::default() })
                        .map_err(RetainedExecutionError::Stopped)?.retain();
                    if affines.contains(&value.definition()) {
                        return Err(RetainedExecutionError::Unsupported(
                            Unsupported::RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs));
                    }
                }
                Ok(())
            })
        })).map_err(protocol).and_then(|(result, _)| result);
        check_resources(&resources)?;
        self.context
            .lifecycle()
            .validate()
            .map_err(RetainedExecutionError::Source)?;
        result
    }
}
