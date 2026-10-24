// SPDX-License-Identifier: MPL-2.0
//! Atomic terminal acceptance for source-protected whole-product removal only.
use super::*;
use super::super::session_run::Publication;
use ifc_lite_geometry::RemovalCommitError;
/// A non-cloneable, already committed whole-product removal. There is no API to
/// reapply its effect to another owner/product. Consuming it yields zero meshes
/// and zero instances plus this product's final diagnostic reports.
pub struct PublishedRetainedRemoval {
    product: u32,
    output: ProducedElementMeshes,
}
impl PublishedRetainedRemoval {
    pub fn product_id(&self) -> u32 { self.product }
    pub fn into_output(self) -> ProducedElementMeshes { self.output }
}
impl From<ProgramStop> for RetainedExecutionError {
    fn from(stop: ProgramStop) -> Self { Self::Stopped(stop) }
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_,R> {
    fn terminal_authority(&self, decoder: &EntityDecoder, router: &GeometryRouter,
        worker: &impl RetainedRuntime<Receipt=R>) -> Result<(),RetainedExecutionError> {
        self.validate(decoder,router)?;
        if self.pending.is_some() || self.outer.is_some() || self.program.is_some()
            || !matches!(self.state.stage,Stage::Complete) {
            return Err(protocol("terminal publication has pending work"));
        }
        self.state.protocol.idle().map_err(protocol)?;
        self.validate_witness()?;
        let domain = worker.domain();
        if domain.incarnation() != Some(worker.incarnation()) || worker.incarnation() == 0 {
            return Err(protocol("terminal worker retired"));
        }
        for (_,receipt) in &self.ledger {
            receipt.validate_live().map_err(protocol)?;
            if !receipt.owner().same_domain(&domain) { return Err(protocol("foreign terminal worker")); }
        }
        self.authenticate_openings(self.plan.as_ref().ok_or_else(||protocol("missing terminal plan"))?)?;
        Ok(())
    }
    /// Commit exactly once under the original owners and resource context.
    /// Nonempty products still require the separate final publication gates.
    /// The returned value is terminal, unlike `into_witness`.
    pub fn publish_removed(&mut self, decoder: &mut EntityDecoder, router: &GeometryRouter,
        worker: &impl RetainedRuntime<Receipt=R>) -> Result<PublishedRetainedRemoval,RetainedExecutionError> {
        if self.terminal_attempted { return Err(protocol("terminal publication already attempted")); }
        self.terminal_attempted = true; // also persists on unwind: never retry hooks
        let resources = self.resources.clone();
        let product = self.state.job.id;
        let mut publication = Publication::new(router);
        let result = router.commit_removed_host(product, &resources, || {
            resources.with_scope(|| {
            self.terminal_authority(decoder,router,worker)?;
            terminal_policy::validate(self)?;
            // Publication owns drained diagnostics BEFORE the owner commits;
            // its Drop quarantines them on Err or unwind, including WrongOwner.
            let (result,_) = router.with_product_csg_scope(|| self.owner.work(decoder,router,|_,router| self.scopes.with_scope(|| {
                let failures = router.finish_product_csg_failures().map_err(RetainedExecutionError::Stopped)?;
                let mut output = super::super::session_canonical::stopped_output();
                output.csg_failures = failures;
                publication.output = Some(output);
                resources.check().map_err(RetainedExecutionError::Stopped)
            }))).map_err(protocol)?;
            result?;
            // All fallible owner commits and final hooks have now completed.
            // Revalidate source, worker and the captured stop after those hooks.
            self.terminal_authority(decoder,router,worker)?;
            Ok::<_,RetainedExecutionError>(())
            })?;
            // Captured scope restoration can retain a late source stop. Check
            // again after it, with no guard/callback left before effect commit.
            self.terminal_authority(decoder,router,worker)?;
            publication.output.take().ok_or_else(||protocol("missing terminal output"))
        });
        match result {
            Ok(output) => {
                self.failed = true; // consume this continuation; never replay
                Ok(PublishedRetainedRemoval { product, output })
            }
            Err(error) => {
                self.cancel();
                Err(match error {
                    RemovalCommitError::AlreadyConsumed => protocol("host removal already published"),
                    RemovalCommitError::Stopped(stop) => RetainedExecutionError::Stopped(stop),
                    RemovalCommitError::Rejected(error) => error,
                })
            }
        }
    }
}
