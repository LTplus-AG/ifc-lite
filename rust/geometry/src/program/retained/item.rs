// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::program::inner::retained_program::RetainedProgramError;
impl ItemControl {
    pub(in crate::program) fn retained_ready(&self) -> bool {
        matches!(self.step, Some(ItemStep::RetainedReady(..)))
    }
    pub(in crate::program) fn admit_retained(
        &mut self,
    ) -> std::result::Result<(ItemStep, RetainedPlanOperation), RetainedProgramError> {
        let Some(ItemStep::RetainedReady(operation, selection)) = self.step.as_ref() else {
            return Err(RetainedProgramError::StaleRequest);
        };
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        {
            let _ = operation;
            match *selection {}
        }
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        {
            let value = operation.value().try_copy().map_err(|error| match error {
                crate::Error::ProgramStopped(stop) => RetainedProgramError::Stopped(stop),
                _ => RetainedProgramError::Unsupported,
            })?;
            // Last fallible check precedes taking the reached operation.
            crate::resource::check_current().map_err(RetainedProgramError::Stopped)?;
            let selection = selection.clone();
            let Some(ItemStep::RetainedReady(operation, _)) = self.step.take() else {
                return Err(RetainedProgramError::StaleRequest);
            };
            Ok((
                ItemStep::RetainedComplete(Ok(Box::new(value)), selection),
                *operation,
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
