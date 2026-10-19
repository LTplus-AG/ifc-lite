// SPDX-License-Identifier: MPL-2.0
//! Common opening source/numerical/child control, shared by canonical adapters.
mod classify;
pub(in crate::program) mod control;
mod decision;
mod effects;
pub(crate) mod execute;
mod planar;
mod ready;
mod rectangular;
pub(in crate::program) mod retained;
pub(in crate::program) mod requests;
use crate::router::voids::VoidContext;
use crate::Result;
#[cfg(test)]
use crate::GeometryRouter;
pub(crate) use classify::Classifier;
use control::Step;
pub(crate) use control::{OpeningControl, OpeningOutput, OpeningPoll};
use ifc_lite_core::DecodedEntity;
#[cfg(test)]
use ifc_lite_core::EntityDecoder;
pub(crate) use requests::{OpeningChild, OpeningReady, OpeningReply, OpeningSource};

pub(crate) struct HostOpenings {
    host: DecodedEntity,
    ids: Vec<u32>,
    context: Option<VoidContext>,
    next: Option<OpeningPoll>,
    phase: Phase,
    retained: bool,
}
#[derive(Clone, Copy)]
enum Phase {
    Classify,
    Rectangular,
    Planar,
    Pending,
}
impl HostOpenings {
    #[cfg(test)]
    pub(crate) fn new(host: &DecodedEntity, ids: &[u32]) -> Self {
        Self::from_owned(host.clone(), ids.to_vec())
    }
    pub(super) fn from_owned(host: DecodedEntity, ids: Vec<u32>) -> Self {
        Self {
            host,
            ids,
            retained: false,
            context: Some(VoidContext {
                openings: Vec::new(),
                merged_openings: Vec::new(),
                param: None,
                bool2d: None,
            }),
            next: None,
            phase: Phase::Classify,
        }
    }
    pub(super) fn select_retained(&mut self) { self.retained = true; }
    pub(super) fn poll(&mut self) -> Step {
        if let Some(next) = self.next.take() {
            return Step::Poll(next);
        }
        let phase = std::mem::replace(&mut self.phase, Phase::Pending);
        match phase {
            Phase::Classify => {
                let ids=if self.retained {std::mem::take(&mut self.ids)} else {self.ids.clone()};
                Step::Child(OpeningControl::classifier_for_contract(self.host.clone(),ids,true,self.retained))
            },
            Phase::Rectangular => Step::Child(OpeningControl::rectangle(
                self.host.clone(),
                self.ids.clone(),
            )),
            Phase::Planar => {
                Step::Child(OpeningControl::planar(self.host.clone(), self.ids.clone()))
            }
            Phase::Pending => Step::Poll(OpeningPoll::Pending),
        }
    }
    pub(super) fn resume(&mut self, reply: OpeningReply) -> Result<()> {
        match reply {
            OpeningReply::Merged(openings, merged) => {
                let context = self.context.as_mut().expect("opening context");
                context.openings = openings;
                context.merged_openings = merged;
                self.next = Some(OpeningPoll::Source(OpeningSource::Gate(
                    requests::OpeningGate::Parametric,
                )));
            }
            OpeningReply::Gate(enabled) => {
                if matches!(self.phase, Phase::Rectangular) {
                    if enabled {
                        self.next = None;
                    } else {
                        self.queue_planar_gate();
                    }
                } else if enabled {
                    self.phase = Phase::Planar
                } else {
                    self.finish()
                }
            }
            OpeningReply::Finished(output) => self.next = Some(OpeningPoll::Complete(Ok(output))),
            _ => unreachable!("host opening reply tag"),
        }
        Ok(())
    }
    fn queue_planar_gate(&mut self) {
        self.phase = Phase::Pending;
        self.next = Some(OpeningPoll::Source(OpeningSource::Gate(
            requests::OpeningGate::Planar,
        )));
    }
    fn finish(&mut self) {
        self.next = Some(OpeningPoll::Ready(OpeningReady::Finish(
            OpeningOutput::Context(std::sync::Arc::new(
                self.context.take().expect("opening context"),
            )),
        )));
    }
    pub(super) fn child_complete(&mut self, output: Result<OpeningOutput>) -> Result<()> {
        match output? {
            OpeningOutput::RetainedClassified(openings) => {
                // Defer before reaching mesh-only probes; source admissions and
                // occurrence work are retained, with no provisional effects to refund.
                crate::resource::charge(crate::resource::Cost {
                    live_bytes:(std::mem::size_of::<retained::RetainedVoidContext>()+2*std::mem::size_of::<usize>()) as u64,
                    work:1,..Default::default()
                })?.retain();
                self.next=Some(OpeningPoll::Ready(OpeningReady::Finish(
                    OpeningOutput::RetainedContext(std::sync::Arc::new(retained::RetainedVoidContext {
                        openings, grouping:retained::GroupEligibility::DeferredMeshOnlyProbes,
                    })))));
            }
            OpeningOutput::Classified(openings) => {
                self.phase = Phase::Rectangular;
                self.next = Some(OpeningPoll::Ready(OpeningReady::Merge(openings)));
            }
            OpeningOutput::Rectangle(param) => {
                self.context.as_mut().expect("opening context").param = param;
                self.queue_planar_gate();
            }
            OpeningOutput::Planar(planar) => {
                self.context.as_mut().expect("opening context").bool2d = planar;
                self.finish();
            }
            _ => unreachable!("host opening child output"),
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn run(
        self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<VoidContext> {
        match OpeningControl::from_host(self).drain(router, decoder)? {
            OpeningOutput::Context(context) => Ok(
                std::sync::Arc::into_inner(context).expect("unique synchronous opening context")
            ),
            _ => unreachable!("opening context output"),
        }
    }
}
fn source_option<T>(result: Result<T>) -> Result<Option<T>> {
    match crate::resource::observe(result) {
        Ok(value) => Ok(Some(value)),
        Err(error @ crate::Error::ProgramStopped(_)) => Err(error),
        Err(_) => Ok(None),
    }
}
#[cfg(test)]
mod control_tests;
#[cfg(test)]
mod raw_terminal_tests;
#[cfg(test)]
mod terminal_tests;
#[cfg(test)]
mod tests;
