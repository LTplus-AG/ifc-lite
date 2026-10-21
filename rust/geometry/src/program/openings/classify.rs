// SPDX-License-Identifier: MPL-2.0
//! A host's requested opening occurrences, classified one at a time. Each
//! occurrence owns its body parts and probe results; per-item probes run as
//! child controls and every classification decision is a numerical packet.
use super::requests::{OpeningReady, OpeningReply, OpeningSource};
use super::{protocol, source_option, OpeningOutput, OpeningPoll};
use crate::program::opening::{OpeningBounds, OpeningChild, OpeningProgram};
use crate::router::processing::SourceHygiene;
use crate::router::voids::OpeningType;
use crate::router::OpeningDiagnostic;
use crate::{GeometryRouter, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use std::collections::VecDeque;

pub(crate) struct Classifier<'a> {
    host: &'a DecodedEntity,
    ids: std::slice::Iter<'a, u32>,
    /// QUIET mode (`false`) is a full no-op for statistics and diagnostics: a
    /// residual subset of an already classified host must not count twice.
    recording: bool,
    requested: u32,
    current: Option<Occurrence>,
    probe: Option<OpeningProgram>,
    phase: Phase,
    next: Option<OpeningPoll>,
    output: Vec<OpeningType>,
    diagnostic: Vec<OpeningDiagnostic>,
    /// Requested id and vertex count attributed to the running decisions.
    decision: (u32, usize),
}

#[derive(Clone, Copy)]
enum Phase {
    Decode,
    Body,
    Bounds,
    Fallback,
    ItemMeshes,
    Classify,
    Finished,
    Waiting,
}

/// One requested occurrence. Diagnostics name the REQUESTED id, never the id
/// of whatever entity a compatibility cache returned for it.
struct Occurrence {
    requested_id: u32,
    entity: DecodedEntity,
    parts: VecDeque<Mesh>,
    bounds: OpeningBounds,
    meshes: Vec<Mesh>,
    triangles: usize,
    vertices: usize,
}

impl<'a> Classifier<'a> {
    pub(super) fn new(host: &'a DecodedEntity, ids: &'a [u32], recording: bool) -> Self {
        Self {
            host,
            ids: ids.iter(),
            recording,
            requested: 0,
            current: None,
            probe: None,
            phase: Phase::Decode,
            next: None,
            output: Vec::new(),
            diagnostic: if recording { Vec::with_capacity(ids.len()) } else { Vec::new() },
            decision: (0, 0),
        }
    }

    pub(super) fn poll(&mut self) -> OpeningPoll {
        loop {
            if let Some(next) = self.next.take() {
                return next;
            }
            if let Some(probe) = &mut self.probe {
                match probe.poll() {
                    OpeningPoll::Complete(output) => {
                        self.probe = None;
                        if let Err(error) = self.child_complete(output) {
                            self.fail(error);
                        }
                        continue;
                    }
                    poll => return poll,
                }
            }
            let phase = std::mem::replace(&mut self.phase, Phase::Waiting);
            match phase {
                Phase::Decode => {
                    let Some(&id) = self.ids.next() else {
                        return OpeningPoll::Ready(OpeningReady::FinishClassifier {
                            output: std::mem::take(&mut self.output),
                            diagnostic: std::mem::take(&mut self.diagnostic),
                        });
                    };
                    self.requested = id;
                    return OpeningPoll::Source(OpeningSource::Decode);
                }
                Phase::Body => return OpeningPoll::Source(OpeningSource::Body),
                Phase::Bounds | Phase::Fallback => {
                    self.phase = phase;
                    self.probe = Some(OpeningProgram::new(false));
                }
                Phase::ItemMeshes => {
                    self.phase = phase;
                    self.probe = Some(OpeningProgram::new(true));
                }
                Phase::Classify => {
                    let Some(current) = self.current.take() else {
                        return OpeningPoll::Complete(Err(protocol("classifier occurrence")));
                    };
                    self.decision = (current.requested_id, current.vertices);
                    let decisions =
                        super::decision::classify(current.parts, current.bounds, current.meshes);
                    return OpeningPoll::Ready(OpeningReady::Decision(decisions));
                }
                Phase::Finished => {
                    let output = std::mem::take(&mut self.output);
                    return OpeningPoll::Complete(Ok(OpeningOutput::Classified(output)));
                }
                Phase::Waiting => {
                    return OpeningPoll::Complete(Err(protocol("classifier reply pending")))
                }
            }
        }
    }

    fn fail(&mut self, error: crate::Error) {
        self.phase = Phase::Waiting;
        self.next = Some(OpeningPoll::Complete(Err(error)));
    }

    pub(super) fn source(
        &self,
        source: OpeningSource,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> OpeningReply {
        match (&self.probe, &self.current, source) {
            (Some(probe), Some(current), _) => probe.source(&current.entity, source, router, decoder),
            (None, _, OpeningSource::Decode) => {
                OpeningReply::Decoded(decoder.decode_by_id(self.requested).map_err(Into::into))
            }
            // The cutter is kept in WHATEVER frame the product pipeline gives
            // it (world, or the opening's own local frame on wasm); an opening
            // whose items lie >= 1 km apart is several frame parts (#6349).
            (None, Some(current), OpeningSource::Body) => OpeningReply::Parts(
                router.process_element_parts_with_hygiene(
                    &current.entity,
                    decoder,
                    SourceHygiene::BooleanOperand,
                ),
            ),
            _ => OpeningReply::Refused(protocol("classifier source")),
        }
    }

    pub(super) fn child(&self, router: &GeometryRouter) -> Result<OpeningChild<'_>> {
        match &self.probe {
            Some(probe) => probe.child(router),
            None => Err(protocol("classifier child")),
        }
    }

    pub(super) fn resume(&mut self, reply: OpeningReply, router: &GeometryRouter) {
        if let Some(probe) = &mut self.probe {
            return probe.resume(reply);
        }
        if let Err(error) = self.accept(reply, router) {
            self.fail(error);
        }
    }

    fn current(&mut self) -> Result<&mut Occurrence> {
        self.current.as_mut().ok_or_else(|| protocol("classifier occurrence"))
    }

    fn accept(&mut self, reply: OpeningReply, router: &GeometryRouter) -> Result<()> {
        match reply {
            // An undecodable id or a failed body skips only this occurrence.
            OpeningReply::Decoded(reply) => {
                self.current = source_option(reply)?.map(|entity| Occurrence {
                    requested_id: self.requested,
                    entity,
                    parts: VecDeque::new(),
                    bounds: Vec::new(),
                    meshes: Vec::new(),
                    triangles: 0,
                    vertices: 0,
                });
                self.phase = if self.current.is_some() { Phase::Body } else { Phase::Decode };
            }
            OpeningReply::Parts(reply) => match source_option(reply)? {
                Some(parts) => self.next = Some(OpeningPoll::Ready(OpeningReady::Metrics(parts))),
                None => self.skip(),
            },
            OpeningReply::Metrics(parts, triangles, vertices) => {
                if parts.is_empty() {
                    self.skip();
                    return Ok(());
                }
                let current = self.current()?;
                current.parts = parts;
                current.triangles = triangles;
                current.vertices = vertices;
                // Per-item bounds are probed up front for every occurrence.
                self.phase = Phase::Bounds;
            }
            OpeningReply::BoundsDecision(bounds, separable) => {
                let current = self.current()?;
                current.bounds = bounds;
                // A high-triangle single-body opening (circular / arched /
                // faceted sweep) carries a per-part AABB fallback (#635).
                self.phase = if current.triangles > 100 && !separable {
                    Phase::Fallback
                } else if !current.bounds.is_empty() {
                    Phase::ItemMeshes
                } else {
                    Phase::Classify
                };
            }
            OpeningReply::Fallback(opening) => {
                let current = self.current()?;
                let (id, vertices, done) = (current.requested_id, current.vertices, current.parts.is_empty());
                self.publish(opening, id, vertices, router);
                if done {
                    self.skip();
                } else {
                    self.phase = Phase::Fallback;
                }
            }
            OpeningReply::Decision(decisions, Some(opening)) => {
                let (id, vertices) = self.decision;
                self.publish(opening, id, vertices, router);
                self.next = Some(OpeningPoll::Ready(OpeningReady::Decision(decisions)));
            }
            OpeningReply::Decision(_, None) => self.phase = Phase::Decode,
            OpeningReply::ClassifierFinished(output, diagnostic) => {
                // Published once per completed host; an interrupted host is not.
                // `host.ifc_type` displays as its STEP name.
                if self.recording && !diagnostic.is_empty() {
                    let host_type = format!("{}", self.host.ifc_type);
                    router.record_host_opening_diagnostic(self.host.id, &host_type, diagnostic);
                }
                self.output = output;
                self.phase = Phase::Finished;
            }
            OpeningReply::Refused(error) => return Err(error),
            _ => return Err(protocol("classifier reply")),
        }
        Ok(())
    }

    fn skip(&mut self) {
        self.current = None;
        self.phase = Phase::Decode;
    }

    /// Bump the aggregate counter and push the per-host line together.
    fn publish(&mut self, opening: OpeningType, id: u32, vertices: usize, router: &GeometryRouter) {
        if self.recording {
            let (counter, kind) = super::decision::kind(&opening);
            router.bump_classification(counter);
            self.diagnostic.push(OpeningDiagnostic { opening_id: id, kind, vertex_count: vertices });
        }
        self.output.push(opening);
    }

    /// A probe child completed; an ordinary probe failure reads as empty,
    /// exactly as the compatibility probes' `unwrap_or_default` did.
    fn child_complete(&mut self, output: Result<OpeningOutput>) -> Result<()> {
        let output = source_option(output)?;
        let phase = std::mem::replace(&mut self.phase, Phase::Waiting);
        match (phase, output) {
            (Phase::Bounds, output) => {
                let bounds = probe_bounds(output)?;
                self.next = Some(OpeningPoll::Ready(OpeningReady::BoundsDecision(bounds)));
            }
            (Phase::Fallback, output) => {
                let bounds = probe_bounds(output)?;
                let mesh = self.current()?.parts.pop_front().ok_or_else(|| protocol("fallback part"))?;
                self.next = Some(OpeningPoll::Ready(OpeningReady::Fallback { mesh, bounds }));
            }
            (Phase::ItemMeshes, output) => {
                let meshes = match output {
                    Some(OpeningOutput::Meshes(meshes)) => meshes,
                    None => Vec::new(),
                    Some(_) => return Err(protocol("opening meshes output")),
                };
                self.current()?.meshes = meshes;
                self.phase = Phase::Classify;
            }
            _ => return Err(protocol("classifier child continuation")),
        }
        Ok(())
    }
}

fn probe_bounds(output: Option<OpeningOutput>) -> Result<OpeningBounds> {
    match output {
        Some(OpeningOutput::Bounds(bounds)) => Ok(bounds),
        None => Ok(Vec::new()),
        Some(_) => Err(protocol("opening bounds output")),
    }
}
