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
    observed_cut_times_ms: &mut Vec<f64>,
) -> Result<witness::RuntimeProductWitness<W::Receipt>, RetainedExecutionError> {
    while execution.advance_source(decoder, router)? {
        let worker = match &mut *worker {
            Some(worker) => worker,
            slot @ None => slot.insert(acquire()?),
        };
        let issued = execution
            .issue_next(decoder, router, worker)?
            .ok_or_else(|| protocol(ReceiptFailure::MissingAdmission))?;
        let is_cut = execution.prepared.is_none() && matches!(execution.openings, Some(OpeningPhase::Cuts));
        if is_cut {
            execution.scratch.reserve(&execution.resources, &mut execution.cut_times_ms, 1)?;
            // Keep diagnostic observations even if acceptance/publication fails.
            // Both vectors are charged to this product's existing live budget.
            execution.scratch.reserve(&execution.resources, observed_cut_times_ms, 1)?;
        }
        let cut_start = resource::BudgetStart::now();
        let result = issued.execute_async(worker, limits).await;
        if is_cut {
            let ms = cut_start.elapsed().as_secs_f64() * 1000.;
            execution.cut_times_ms.push(ms);
            observed_cut_times_ms.push(ms);
        }
        let completed = match result {
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
    execution.into_witness(limits.chord_metres)
}
