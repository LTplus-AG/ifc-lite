// SPDX-License-Identifier: MPL-2.0
//! One attempt per product, with no lexical source/resource scope across await.
use super::runtime::{AsyncRetainedExecutor, NumericalLimits, RuntimeFault};
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
        let worker = match worker {
            Some(worker) => worker,
            slot @ None => slot.insert(acquire()?),
        };
        let issued = execution
            .issue_next(decoder, router, worker)?
            .ok_or_else(|| protocol(ReceiptFailure::MissingAdmission))?;
        let completed = issued
            .execute_async(worker, limits)
            .await
            .map_err(|error| error.reason)?;
        execution
            .accept(completed, decoder, router)
            .map_err(|rejected| rejected.reason)?;
    }
    execution.into_witness()
}
