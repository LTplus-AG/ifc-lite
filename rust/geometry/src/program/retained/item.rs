// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::program::inner::retained_program::RetainedProgramError;
use crate::program::retained::failure;
impl ItemControl {
    pub(in crate::program) fn retained_ready(&self) -> bool {
        crate::program::retained::ENABLED && matches!(self.step, Some(ItemStep::RetainedReady(..)))
            || matches!(&self.step, Some(ItemStep::Boolean { machine, .. }) if machine.retained_ready())
    }
    pub(in crate::program) fn admit_retained(
        &mut self,
    ) -> std::result::Result<(ItemStep, Vec<RetainedPlanOperation>), RetainedProgramError> {
        if let Some(ItemStep::Boolean { machine, .. }) = &mut self.step {
            let operation = machine.admit_retained().map_err(|error| match error {
                Error::ProgramStopped(stop) => RetainedProgramError::Stopped(stop),
                _ => RetainedProgramError::Unsupported,
            })?;
            let step = self.step.take().ok_or(RetainedProgramError::StaleRequest)?;
            return Ok((step, operation));
        }
        let Some(ItemStep::RetainedReady(operation, selection)) = self.step.as_ref() else {
            return Err(RetainedProgramError::StaleRequest);
        };
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        {
            let _ = operation;
            match *selection {}
        }
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        {
            let mut operations = Vec::new();
            crate::resource::reserve_headers(&mut operations, 1).map_err(RetainedProgramError::Stopped)?.retain();
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


pub(super) fn execute_boolean(item: &DecodedEntity, mut machine: Box<BooleanMachine>,
    reports: ConstructionReports, router: &GeometryRouter, decoder: &mut EntityDecoder) -> ItemStep {
    let Some(selection) = machine.retained_selection().cloned() else {
        return ItemStep::Complete(ItemResult { result: Err(Error::geometry("missing retained selection")), reports });
    };
    let result = (|| {
        crate::resource::check_current()?;
        let recorder = router.processor_for(&item.ifc_type).and_then(|processor| processor.boolean_recorder())
            .ok_or_else(|| Error::geometry("selected Boolean processor unavailable"))?;
        machine.retained_source(recorder, router, decoder)?;
        if machine.stage().is_none() { machine.finish_retained().map(|value| Some(Box::new(value))) }
        else { Ok(None) }
    })();
    match result {
        Ok(None) => ItemStep::Boolean { machine, reports },
        Ok(Some(value)) => ItemStep::RetainedComplete(Ok(value), selection),
        Err(error) => {
            // Keep the owned error reply consumable. Specific Boolean/recipe
            // origins already recorded below this adapter always win; a helper
            // not yet converted is preserved as opaque at this known source.
            let error = match error {
                Error::ProgramStopped(_) => error,
                error => {
                    let diagnostic = Error::geometry(error.to_string());
                    let cause = match error {
                        Error::CoreError(core) => failure::OriginCause::Core(core),
                        other => failure::OriginCause::Opaque(other),
                    };
                    selection.failure_handle().record(failure::FailureSite::BooleanSource, Some(item.id), cause);
                    diagnostic
                }
            };
            ItemStep::RetainedComplete(Err(error), selection)
        }
    }
}
