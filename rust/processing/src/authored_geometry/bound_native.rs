// SPDX-License-Identifier: MPL-2.0
//! Explicit native retained executor. It cannot consume a host-trusted packet.
use super::{bound::{source_error, ModelBoundRetainedDocument}, evaluator::{DisplayPublication, RetainedDisplayContract}};
use crate::AnalyticSourceKey;
use ifc_lite_geometry::document::{DefinitionHandle, EvaluationContract, OccurrenceHandle, RetainedRefusal, RetainedRequest};
use ifc_lite_geometry_runtime::{MeshLimits, RetainedRealization, SmlibWorker, WorkerError};
use std::sync::Arc;

/// Owned numerical input; its private identity is matched to the executor slot.
/// Contains no source bundle, decoder, maps or caller-created lifecycle authority.
pub struct IssuedRetainedWork { ticket: Arc<()>, request: RetainedRequest }

/// Opaque delivered receipt. Dropping unaccepted work retires its captured
/// process domain, so an abandoned or invalidated solid cannot leak.
#[derive(Debug)]
pub struct CompletedRetainedWork { ticket: Arc<()>, realization: RetainedRealization }
impl CompletedRetainedWork {
    pub fn realization(&self) -> &RetainedRealization { &self.realization }
}
impl Drop for CompletedRetainedWork {
    fn drop(&mut self) { self.realization.owner().retire(); }
}

#[derive(Debug)]
pub struct RejectedRetainedWork { pub reason: RetainedRefusal, pub work: CompletedRetainedWork }

/// One shared display definition and its rigid occurrences. This keeps the exact
/// immutable SDK receipt alive separately from all occurrence definitions.
pub struct PublishedBoundSource {
    pub product_id: u32,
    pub definition: DefinitionHandle,
    pub occurrence: OccurrenceHandle,
    pub mapped_occurrences: Vec<(u32, OccurrenceHandle)>,
    pub work: CompletedRetainedWork,
}

impl ModelBoundRetainedDocument {
    /// One explicit pending operation per executor. The slot retains only a weak
    /// ticket: terminal execution errors and abandoned issued work free admission. The actual selected native
    /// owner supplies liveness; an integer supplied by a caller grants nothing.
    pub fn issue(&mut self, key: &AnalyticSourceKey, worker: &SmlibWorker)
        -> Result<IssuedRetainedWork, RetainedRefusal>
    {
        self.lifecycle.validate().map_err(source_error)?;
        if self.pending.as_ref().is_some_and(|ticket| ticket.strong_count() != 0) {
            return Err(RetainedRefusal::InvalidSource("retained executor already pending"));
        }
        let request = self.document.prepare(key, EvaluationContract::RetainedBrep, worker.incarnation())?;
        let ticket = Arc::new(());
        self.pending = Some(Arc::downgrade(&ticket));
        Ok(IssuedRetainedWork { ticket, request })
    }

    /// Execute only issued work. No replay or switch to the exact engine occurs.
    /// Work is checked both before execution and after the actual SDK returns.
    pub fn execute(&self, issued: IssuedRetainedWork, worker: &mut SmlibWorker,
        chord_metres: f64, angle_degrees: f64, limits: MeshLimits)
        -> Result<CompletedRetainedWork, WorkerError>
    {
        self.lifecycle.validate().map_err(|e| WorkerError::Authored(e.to_string()))?;
        if !self.pending.as_ref().and_then(std::sync::Weak::upgrade).is_some_and(|ticket| Arc::ptr_eq(&ticket, &issued.ticket)) {
            return Err(WorkerError::Authored("foreign retained executor ticket".into()));
        }
        let realization = worker.evaluate_retained_extrusion(issued.request, chord_metres, angle_degrees, limits)?;
        let work = CompletedRetainedWork { ticket: issued.ticket, realization };
        // Dropping work on either failure retires its actual captured domain.
        self.lifecycle.validate().map_err(|e| WorkerError::Authored(e.to_string()))?;
        work.realization.validate_live()?;
        Ok(work)
    }

    /// Wrong, stale, foreign or unsupported packets return intact. The only
    /// numerical packet admitted here is the exact immutable runtime receipt.
    pub fn accept(&mut self, work: CompletedRetainedWork, occurrence_index: usize,
        contract: RetainedDisplayContract) -> Result<PublishedBoundSource, Box<RejectedRetainedWork>>
    {
        // Establish ownership before this document may retire any runtime. An
        // expired foreign receiver has no authority over another issued packet.
        if !self.pending.as_ref().and_then(std::sync::Weak::upgrade)
            .is_some_and(|ticket| Arc::ptr_eq(&ticket, &work.ticket)) {
            return Err(Box::new(RejectedRetainedWork {
                reason: RetainedRefusal::InvalidSource("foreign retained executor ticket"), work,
            }));
        }
        if let Err(error) = self.lifecycle.validate() {
            // The numerical packet returns intact, but expired source authority
            // cannot keep its own real worker allocation alive awaiting Drop.
            work.realization.owner().retire();
            return Err(Box::new(RejectedRetainedWork { reason: source_error(error), work }));
        }
        if work.realization.validate_live().is_err() {
            return Err(Box::new(RejectedRetainedWork { reason: RetainedRefusal::InvalidRuntime, work }));
        }
        let live = work.realization.owner().incarnation().unwrap_or(0);
        let publication = self.document.publish_borrowed(work.realization.completion(), occurrence_index, live, contract);
        let DisplayPublication { definition, occurrences, transforms, product_id } = match publication {
            Ok(value) => value,
            Err(reason) => return Err(Box::new(RejectedRetainedWork { reason, work })),
        };
        self.pending = None;
        Ok(PublishedBoundSource { product_id, definition, occurrence: occurrences[occurrence_index],
            mapped_occurrences: transforms.iter().zip(occurrences).map(|((id, _), handle)| (*id, handle)).collect(), work })
    }

    /// Cancelling a pending slot makes all issued/delivered tickets stale.
    /// Dropping a delivered receipt retires only its captured process domain.
    pub fn cancel_pending(&mut self) { self.pending = None; }
}
