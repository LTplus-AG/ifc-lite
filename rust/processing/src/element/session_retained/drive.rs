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
    observation: &mut super::model::ProductObservation<W::Receipt>,
) -> Result<witness::RuntimeProductWitness<W::Receipt>, RetainedExecutionError> {
    while execution.advance_source(decoder, router)? {
        let worker = match &mut *worker {
            Some(worker) => worker,
            slot @ None => slot.insert(acquire()?),
        };
        let issued = match execution.issue_next(decoder, router, worker) {
            Ok(Some(issued)) => issued,
            Ok(None) => return Err(protocol(ReceiptFailure::MissingAdmission)),
            Err(error) => {
                // A post-issuance refusal cancels an installed packet through the
                // controller; record its provenance so the replacement is uncharged.
                observation.cancellation =
                    execution.pending.as_ref().map(|pending| pending.cancellation.clone());
                return Err(error);
            }
        };
        observation.cancellation = Some(issued.cancellation.clone());
        let is_cut = execution.prepared.is_none() && matches!(execution.openings, Some(OpeningPhase::Cuts));
        if is_cut {
            execution.scratch.reserve(&execution.resources, &mut execution.cut_times_ms, 1)?;
            // Keep diagnostic observations even if acceptance/publication fails.
            // Both vectors are charged to this product's existing live budget.
            execution.scratch.reserve(&execution.resources, &mut observation.cut_times_ms, 1)?;
        }
        let cut_start = resource::BudgetStart::now();
        let result = issued.execute_async(worker, limits).await;
        if is_cut {
            let ms = cut_start.elapsed().as_secs_f64() * 1000.;
            execution.cut_times_ms.push(ms);
            observation.cut_times_ms.push(ms);
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
                } else if !error.reason.controller_cancelled() {
                    if let Some(pending) = &execution.pending { pending.cancellation.fault(); }
                }
                return Err(error.reason);
            }
        };
        if let Err(rejected) = execution.accept(completed, decoder, router) {
            // The model abandons this product even for a recoverable caller
            // error. Its drop must not turn a receipt fault into a free cancel.
            if !rejected.reason.controller_cancelled() {
                if let Some(pending) = &execution.pending { pending.cancellation.fault(); }
            }
            return Err(rejected.reason);
        }
    }
    execution.into_witness(limits)
}
