// SPDX-License-Identifier: MPL-2.0
//! Explicit source-only browser counterpart of the native bound executor.
//! Common product/dependency coverage is not inferred from a leaf receipt.
use super::{
    bound::{source_error, ModelBoundRetainedDocument},
    evaluator::{DisplayPublication, RetainedDisplayContract},
};
use crate::AnalyticSourceKey;
use ifc_lite_geometry::document::{
    DefinitionHandle, EvaluationContract, OccurrenceHandle, RetainedRefusal, RetainedRequest,
};
use ifc_lite_geometry_runtime::browser::{BrowserRealization, BrowserWorker};
use std::sync::Arc;

pub struct IssuedBrowserWork {
    ticket: Arc<()>,
    request: RetainedRequest,
}
pub struct CompletedBrowserWork {
    ticket: Arc<()>,
    realization: BrowserRealization,
}
impl CompletedBrowserWork {
    pub fn realization(&self) -> &BrowserRealization {
        &self.realization
    }
}
pub struct RejectedBrowserWork {
    pub reason: RetainedRefusal,
    pub work: CompletedBrowserWork,
}
pub struct PublishedBrowserSource {
    product_id: u32,
    definition: DefinitionHandle,
    occurrence: OccurrenceHandle,
    mapped_occurrences: Vec<(u32, OccurrenceHandle)>,
    work: CompletedBrowserWork,
}

impl PublishedBrowserSource {
    pub fn product_id(&self) -> u32 {
        self.product_id
    }
    pub fn definition(&self) -> DefinitionHandle {
        self.definition
    }
    pub fn occurrence(&self) -> OccurrenceHandle {
        self.occurrence
    }
    pub fn mapped_occurrences(&self) -> &[(u32, OccurrenceHandle)] {
        &self.mapped_occurrences
    }
}

impl ModelBoundRetainedDocument {
    pub fn issue_browser(
        &mut self,
        key: &AnalyticSourceKey,
        worker: &BrowserWorker,
    ) -> Result<IssuedBrowserWork, RetainedRefusal> {
        self.lifecycle.validate().map_err(source_error)?;
        if self
            .pending
            .as_ref()
            .is_some_and(|ticket| ticket.strong_count() != 0)
        {
            return Err(RetainedRefusal::InvalidSource(
                "retained executor already pending",
            ));
        }
        let request =
            self.document
                .prepare(key, EvaluationContract::RetainedBrep, worker.incarnation())?;
        let ticket = Arc::new(());
        self.pending = Some(Arc::downgrade(&ticket));
        Ok(IssuedBrowserWork { ticket, request })
    }
    pub async fn execute_browser(
        &self,
        issued: IssuedBrowserWork,
        worker: &mut BrowserWorker,
        chord_metres: f64,
        angle_degrees: f64,
        max_bytes: u32,
    ) -> Result<CompletedBrowserWork, String> {
        self.validate_browser_ticket(&issued.ticket)
            .map_err(|e| e.to_string())?;
        let realization = worker
            .evaluate(issued.request, chord_metres, angle_degrees, max_bytes)
            .await
            .map_err(|e| e.as_string().unwrap_or_else(|| format!("{e:?}")))?;
        let work = CompletedBrowserWork {
            ticket: issued.ticket,
            realization,
        };
        self.validate_browser_ticket(&work.ticket)
            .map_err(|e| e.to_string())?;
        work.realization
            .validate_live()
            .map_err(|e| e.to_string())?;
        Ok(work)
    }
    pub fn accept_browser(
        &mut self,
        work: CompletedBrowserWork,
        occurrence_index: usize,
        contract: RetainedDisplayContract,
    ) -> Result<PublishedBrowserSource, Box<RejectedBrowserWork>> {
        // Check ticket before granting this document retirement authority over
        // a receipt. A foreign receiver never retires another source's Worker.
        if !self
            .pending
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .is_some_and(|ticket| Arc::ptr_eq(&ticket, &work.ticket))
        {
            return Err(Box::new(RejectedBrowserWork {
                reason: RetainedRefusal::InvalidSource("foreign retained executor ticket"),
                work,
            }));
        }
        if let Err(error) = self.lifecycle.validate() {
            work.realization.retire();
            return Err(Box::new(RejectedBrowserWork {
                reason: source_error(error),
                work,
            }));
        }
        if let Err(reason) = work.realization.validate_live() {
            return Err(Box::new(RejectedBrowserWork { reason, work }));
        }
        let publication = self.document.publish_borrowed(
            work.realization.completion(),
            occurrence_index,
            work.realization.incarnation(),
            contract,
        );
        let DisplayPublication {
            definition,
            occurrences,
            transforms,
            product_id,
        } = match publication {
            Ok(value) => value,
            Err(reason) => return Err(Box::new(RejectedBrowserWork { reason, work })),
        };
        self.pending = None;
        Ok(PublishedBrowserSource {
            product_id,
            definition,
            occurrence: occurrences[occurrence_index],
            mapped_occurrences: transforms
                .iter()
                .zip(occurrences)
                .map(|((id, _), handle)| (*id, handle))
                .collect(),
            work,
        })
    }
    /// Published output remains tied to its model source and captured object.
    pub fn validate_browser_publication(
        &self,
        publication: &PublishedBrowserSource,
    ) -> Result<(), RetainedRefusal> {
        // Prove this receiver owns the immutable publication before allowing
        // source-expiry cleanup to retire its captured runtime.
        self.document.document().mesh(publication.definition)?;
        if let Err(error) = self.lifecycle.validate() {
            publication.work.realization.retire();
            return Err(source_error(error));
        }
        publication.work.realization.validate_live()?;
        Ok(())
    }
    pub fn cancel_pending(&mut self) {
        self.pending = None;
    }
    fn validate_browser_ticket(&self, expected: &Arc<()>) -> Result<(), RetainedRefusal> {
        self.lifecycle.validate().map_err(source_error)?;
        if self
            .pending
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .is_some_and(|ticket| Arc::ptr_eq(&ticket, expected))
        {
            Ok(())
        } else {
            Err(RetainedRefusal::InvalidSource(
                "foreign retained executor ticket",
            ))
        }
    }
}
