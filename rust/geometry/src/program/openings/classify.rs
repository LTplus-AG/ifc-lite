// SPDX-License-Identifier: MPL-2.0
//! Requested occurrences own canonical children and one numerical decision at a time.
use super::super::opening::OpeningBounds;
use super::control::{OpeningControl, OpeningOutput, OpeningPoll, Step};
use super::requests::{OpeningChild, OpeningReady, OpeningReply, OpeningSource};
use crate::router::voids::OpeningType;
use crate::router::OpeningDiagnostic;
use crate::{GeometryRouter, Mesh, Result};
use ifc_lite_core::DecodedEntity;
#[cfg(test)]
use ifc_lite_core::EntityDecoder;

pub(crate) struct Classifier {
    host: DecodedEntity,
    ids: std::vec::IntoIter<u32>,
    recording: bool,
    retained: bool,
    retained_output: Vec<super::retained::RetainedOpening>,
    requested: u32,
    current: Option<OpeningOccurrence>,
    phase: Phase,
    next: Option<OpeningPoll>,
    output: Vec<OpeningType>,
    diagnostic: Vec<OpeningDiagnostic>,
    decision_id: u32,
    decision_vertices: usize,
}
#[derive(Clone, Copy)]
enum Phase {
    Decode,
    Body,
    Bounds,
    Fallback,
    ItemMeshes,
    Classify,
    Pending,
    Complete,
}
struct OpeningOccurrence {
    requested_id: u32,
    entity: DecodedEntity,
    parts: std::collections::VecDeque<Mesh>,
    bounds: OpeningBounds,
    meshes: Vec<Mesh>,
    triangles: usize,
    vertices: usize,
}
impl Classifier {
    #[cfg(test)]
    pub(crate) fn new(host: &DecodedEntity, ids: &[u32], recording: bool) -> Self {
        Self::from_owned(host.clone(), ids.to_vec(), recording)
    }
    pub(super) fn from_owned(host: DecodedEntity, ids: Vec<u32>, recording: bool) -> Self {
        Self::for_contract(host, ids, recording, false)
    }
    pub(super) fn for_contract(host:DecodedEntity, ids:Vec<u32>, recording:bool, retained:bool)->Self {
        let capacity = ids.len();
        Self {
            host,
            ids: ids.into_iter(),
            recording,
            retained, retained_output:Vec::new(),
            requested: 0,
            current: None,
            phase: Phase::Decode,
            next: None,
            output: Vec::new(),
            diagnostic: if retained {Vec::new()} else {Vec::with_capacity(capacity)},
            decision_id: 0,
            decision_vertices: 0,
        }
    }
    pub(super) fn poll(&mut self) -> Step {
        if let Some(next) = self.next.take() {
            return Step::Poll(next);
        }
        let phase = std::mem::replace(&mut self.phase, Phase::Pending);
        match phase {
            Phase::Decode => {
                if let Some(id) = self.ids.next() {
                    self.requested = id;
                    Step::Poll(OpeningPoll::Source(OpeningSource::Decode(id)))
                } else if self.retained {
                    Step::Poll(OpeningPoll::Ready(OpeningReady::Finish(
                        OpeningOutput::RetainedClassified(std::mem::take(&mut self.retained_output)))))
                } else {
                    Step::Poll(OpeningPoll::Ready(OpeningReady::FinishClassifier {
                        output: std::mem::take(&mut self.output),
                        diagnostic: std::mem::take(&mut self.diagnostic),
                    }))
                }
            }
            Phase::Body => Step::Poll(OpeningPoll::Geometry(OpeningChild::Body(
                self.current
                    .as_ref()
                    .expect("opening occurrence")
                    .entity
                    .clone(),
            ))),
            Phase::Bounds | Phase::Fallback => {
                self.phase = phase;
                Step::Child(OpeningControl::probe(
                    self.current
                        .as_ref()
                        .expect("opening occurrence")
                        .entity
                        .clone(),
                    false,
                ))
            }
            Phase::ItemMeshes => {
                self.phase = phase;
                Step::Child(OpeningControl::probe(
                    self.current
                        .as_ref()
                        .expect("opening occurrence")
                        .entity
                        .clone(),
                    true,
                ))
            }
            Phase::Classify => {
                let current = self.current.take().expect("opening occurrence");
                self.decision_id = current.requested_id;
                self.decision_vertices = current.vertices;
                Step::Poll(OpeningPoll::Ready(OpeningReady::Decision(
                    super::decision::classify(current.parts, current.bounds, current.meshes),
                )))
            }
            Phase::Complete => Step::Poll(OpeningPoll::Complete(Ok(OpeningOutput::Classified(
                std::mem::take(&mut self.output),
            )))),
            Phase::Pending => Step::Poll(OpeningPoll::Pending),
        }
    }
    fn accept(
        &mut self,
        opening: OpeningType,
        id: u32,
        vertices: usize,
        router: &GeometryRouter,
    ) -> Result<()> {
        crate::resource::check_current()?;
        if self.recording {
            let (counter, kind) = super::decision::kind(&opening);
            router.bump_classification(counter);
            self.diagnostic.push(OpeningDiagnostic {
                opening_id: id,
                kind,
                vertex_count: vertices,
            });
        }
        self.output.push(opening);
        Ok(())
    }
    pub(super) fn resume(&mut self, reply: OpeningReply, router: &GeometryRouter) -> Result<()> {
        match reply {
            OpeningReply::Decoded(reply) => {
                let entity=if self.retained {Some(reply?)} else {super::source_option(reply)?};
                self.current = entity.map(|entity| OpeningOccurrence {
                    requested_id: self.requested,
                    entity,
                    parts: Default::default(),
                    bounds: Vec::new(),
                    meshes: Vec::new(),
                    triangles: 0,
                    vertices: 0,
                });
                self.phase = if self.current.is_some() {
                    Phase::Body
                } else {
                    Phase::Decode
                };
            }
            OpeningReply::RetainedParts(reply) => {
                let values=reply?;
                let current=self.current.take().expect("retained opening occurrence");
                crate::program::retained_walk::charge(values.len() as u64 + 1)?;
                crate::resource::reserve_headers(&mut self.retained_output,1)?.retain();
                self.retained_output.push(super::retained::RetainedOpening {requested_id:current.requested_id,values});
                self.phase=Phase::Decode;
            }
            OpeningReply::Finished(output)=>self.next=Some(OpeningPoll::Complete(Ok(output))),
            OpeningReply::Parts(reply) => match super::source_option(reply)? {
                Some(parts) => self.next = Some(OpeningPoll::Ready(OpeningReady::Metrics(parts))),
                None => self.phase = Phase::Decode,
            },
            OpeningReply::Metrics(parts, triangles, vertices) => {
                if parts.is_empty() {
                    self.phase = Phase::Decode
                } else {
                    let current = self.current.as_mut().expect("opening occurrence");
                    current.parts = parts;
                    current.triangles = triangles;
                    current.vertices = vertices;
                    self.phase = Phase::Bounds;
                }
            }
            OpeningReply::BoundsDecision(bounds, separable) => {
                let current = self.current.as_mut().expect("opening occurrence");
                current.bounds = bounds;
                self.phase = if current.triangles > 100 && !separable {
                    Phase::Fallback
                } else if !current.bounds.is_empty() {
                    Phase::ItemMeshes
                } else {
                    Phase::Classify
                };
            }
            OpeningReply::Fallback(opening) => {
                let current = self.current.as_ref().expect("opening occurrence");
                let id = current.requested_id;
                let vertices = current.vertices;
                let done = current.parts.is_empty();
                self.accept(opening, id, vertices, router)?;
                if done {
                    self.current = None;
                    self.phase = Phase::Decode
                } else {
                    self.phase = Phase::Fallback
                }
            }
            OpeningReply::Decision(decisions, opening) => match opening {
                Some(opening) => {
                    self.accept(opening, self.decision_id, self.decision_vertices, router)?;
                    self.next = Some(OpeningPoll::Ready(OpeningReady::Decision(decisions)));
                }
                None => self.phase = Phase::Decode,
            },
            OpeningReply::ClassifierFinished(output, diagnostic) => {
                if self.recording && !diagnostic.is_empty() {
                    router.record_host_opening_diagnostic(
                        self.host.id,
                        &format!("{}", self.host.ifc_type),
                        diagnostic,
                    );
                }
                self.output = output;
                self.phase = Phase::Complete;
            }
            _ => unreachable!("classifier reply tag"),
        }
        Ok(())
    }
    pub(super) fn child_complete(&mut self, output: Result<OpeningOutput>) -> Result<()> {
        let output = super::source_option(output)?;
        match self.phase {
            Phase::Bounds => {
                let bounds = match output {
                    Some(OpeningOutput::Bounds(bounds)) => bounds,
                    None => Vec::new(),
                    _ => unreachable!("opening bounds output"),
                };
                self.next = Some(OpeningPoll::Ready(OpeningReady::BoundsDecision(bounds)));
            }
            Phase::Fallback => {
                let bounds = match output {
                    Some(OpeningOutput::Bounds(bounds)) => bounds,
                    None => Vec::new(),
                    _ => unreachable!("opening bounds output"),
                };
                let mesh = self
                    .current
                    .as_mut()
                    .expect("opening occurrence")
                    .parts
                    .pop_front()
                    .expect("opening frame part");
                self.next = Some(OpeningPoll::Ready(OpeningReady::Fallback { mesh, bounds }));
            }
            Phase::ItemMeshes => {
                let meshes = match output {
                    Some(OpeningOutput::Meshes(meshes)) => meshes,
                    None => Vec::new(),
                    _ => unreachable!("opening meshes output"),
                };
                self.current.as_mut().expect("opening occurrence").meshes = meshes;
                self.phase = Phase::Classify;
            }
            _ => unreachable!("classifier child continuation"),
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn run(
        self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<Vec<OpeningType>> {
        match OpeningControl::from_classifier(self).drain(router, decoder)? {
            OpeningOutput::Classified(output) => Ok(output),
            _ => unreachable!("classifier output"),
        }
    }
}
#[cfg(test)]
#[path = "requested_identity_tests.rs"]
mod requested_identity_tests;

#[cfg(test)]
#[path="classify_allocation_tests.rs"]
mod allocation_tests;
