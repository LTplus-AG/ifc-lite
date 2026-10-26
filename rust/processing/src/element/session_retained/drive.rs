// SPDX-License-Identifier: MPL-2.0
//! One attempt per product, with no lexical source/resource scope across await.
use super::runtime::{AsyncRetainedExecutor, NumericalLimits, RuntimeFault, RuntimeFaultKind};
use super::*;

pub(super) async fn drive<W: AsyncRetainedExecutor>(
    mut execution: RuntimeProductExecution<'_, W::Receipt>,
    decoder: &mut EntityDecoder<'_>,
    router: &GeometryRouter,
    worker: &mut Option<W>,
    acquire: &mut impl FnMut() -> Result<W, RuntimeFault>,
    limits: NumericalLimits,
) -> Result<witness::RuntimeProductWitness<W::Receipt>, RetainedExecutionError> {
    while execution.advance_source(decoder, router)? {
        let worker = match &mut *worker {
            Some(worker) => worker,
            slot @ None => slot.insert(acquire()?),
        };
        let issued = execution
            .issue_next(decoder, router, worker)?
            .ok_or_else(|| protocol(ReceiptFailure::MissingAdmission))?;
        let completed = match issued.execute_async(worker, limits).await {
            Ok(completed) => completed,
            Err(error) => {
                if matches!(&error.reason, RetainedExecutionError::Runtime(fault) if fault.kind == RuntimeFaultKind::Contract)
                {
                    // invoke settled and its packet is disarmed. Abandon this
                    // product without retiring the healthy numerical domain.
                    execution.pending = None;
                    execution.runtime_domain = None;
                    execution.failed = true;
                    if let Some(program) = &mut execution.program {
                        program.cancel();
                    }
                }
                return Err(error.reason);
            }
        };
        execution
            .accept(completed, decoder, router)
            .map_err(|rejected| rejected.reason)?;
    }
    execution.into_witness()
}
