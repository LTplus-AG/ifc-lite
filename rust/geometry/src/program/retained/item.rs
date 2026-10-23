// SPDX-License-Identifier: MPL-2.0
use super::*;
impl ItemControl {
    pub(in crate::program) fn retained_ready(&self) -> bool {
        matches!(self.step, Some(ItemStep::RetainedReady(..)))
    }
    pub(in crate::program) fn admit_retained(
        &mut self,
    ) -> std::result::Result<(ItemStep, Vec<RetainedPlanOperation>), ProgramError> {
        let Some(ItemStep::RetainedReady(operation, selection)) = self.step.as_ref() else {
            return Err(ProgramError::StaleRequest);
        };
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        {
            let _ = operation;
            match *selection {}
        }
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        {
            let mut operations = Vec::new();
            crate::resource::reserve_headers(&mut operations, 1).map_err(ProgramError::TraversalStopped)?.retain();
            let value = operation.value().try_copy().map_err(|error| match error {
                crate::Error::ProgramStopped(stop) => ProgramError::TraversalStopped(stop),
                _ => ProgramError::UnsupportedRetained,
            })?;
            let selection = selection.clone();
            let Some(ItemStep::RetainedReady(operation, _)) = self.step.take() else {
                return Err(ProgramError::StaleRequest);
            };
            operations.push(*operation);
            Ok((
                ItemStep::RetainedComplete(Ok(Box::new(value)), selection),
                operations,
            ))
        }
    }
    pub(in crate::program) fn take_retained(&mut self) -> Option<Result<LogicalRetainedValue>> {
        match self.step.take() {
            Some(ItemStep::RetainedComplete(value, selection)) => {
                let _ = selection.program();
                Some(value.map(|value| *value))
            }
            other => {
                self.step = other;
                None
            }
        }
    }
}
