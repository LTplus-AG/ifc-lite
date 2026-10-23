// SPDX-License-Identifier: MPL-2.0
//! One opening's per-item probe. The meshed representation items are reached
//! in order; each is meshed by a canonical item child and placed by an owned
//! numerical packet. Bounds probes read the authored extrusion direction first.
use super::openings::ready::ProbePlacement;
use super::openings::requests::{OpeningReady, OpeningReply, OpeningSource};
use super::openings::{protocol, OpeningOutput, OpeningPoll};
use super::GeometryProgram;
use crate::router::processing::SourceHygiene;
use crate::{Error, GeometryRouter, Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

pub(crate) type OpeningBounds = Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)>;

/// Owns only reached items and numerical state; the probed element is lent
/// by the owning controller to each source request.
pub(crate) struct OpeningProgram {
    meshes: bool,
    phase: Phase,
    items: std::vec::IntoIter<DecodedEntity>,
    item: Option<DecodedEntity>,
    offset: Option<(f64, f64, f64)>,
    state: Option<ProbePlacement>,
    next: Option<OpeningPoll>,
}

/// A reached item's child program, borrowing the item from its probe.
pub(crate) struct OpeningChild<'a> {
    program: GeometryProgram<'a>,
    parts: bool,
    /// The occurrence's merged body: a product walk, which runs in place.
    walk: bool,
}

impl<'a> OpeningChild<'a> {
    /// An opening occurrence's merged body under boolean-operand hygiene.
    pub(crate) fn body(entity: &'a DecodedEntity) -> Self {
        Self { program: GeometryProgram::product(entity, SourceHygiene::BooleanOperand), parts: true, walk: true }
    }

    /// Drive the child's own requests. A stop reached by one request ends the
    /// child before its next one, so a sticky stop behind an ordinary miss can
    /// never select a later fallback callback.
    pub(crate) fn run(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Result<Vec<Mesh>> {
        if self.walk {
            // The body is the product walk the host's own parts are: the
            // sticky stop it can reach surfaces when the walk closes.
            crate::resource::check_current()?;
            return self.program.drain_parts(router, decoder);
        }
        let fault = |error| protocol(&format!("opening child {error:?}"));
        loop {
            crate::resource::check_current()?;
            let Some(request) = self.program.request().map_err(fault)? else { break };
            let reply = self.program.execute(request, router, decoder).map_err(fault)?;
            self.program.accept(reply, router).map_err(|rejected| fault(rejected.error))?;
        }
        if self.parts {
            self.program.finish_parts()
        } else {
            self.program.finish().map(|mesh| vec![mesh])
        }
    }
}

#[derive(Clone, Copy)]
enum Phase {
    Admit,
    Item,
    Waiting,
    Complete,
}

impl OpeningProgram {
    /// `meshes` selects world item meshes; otherwise per-part bounds.
    pub(crate) fn new(meshes: bool) -> Self {
        Self {
            meshes,
            phase: Phase::Admit,
            items: Vec::new().into_iter(),
            item: None,
            offset: None,
            state: None,
            next: None,
        }
    }

    pub(crate) fn poll(&mut self) -> OpeningPoll {
        if let Some(next) = self.next.take() {
            return next;
        }
        match std::mem::replace(&mut self.phase, Phase::Waiting) {
            Phase::Admit => OpeningPoll::Source(OpeningSource::Probe),
            Phase::Item => match self.items.next() {
                Some(item) => {
                    self.item = Some(item);
                    self.offset = None;
                    OpeningPoll::Source(if self.meshes {
                        OpeningSource::RawChoice
                    } else {
                        OpeningSource::Direction
                    })
                }
                None => {
                    self.phase = Phase::Complete;
                    self.item = None;
                    OpeningPoll::Complete(match self.state.take() {
                        Some(state) if self.meshes => Ok(OpeningOutput::Meshes(state.placed)),
                        Some(state) => Ok(OpeningOutput::Bounds(state.bounds)),
                        None => Err(protocol("opening probe completed without admission")),
                    })
                }
            },
            Phase::Waiting => OpeningPoll::Complete(Err(protocol("opening probe reply pending"))),
            Phase::Complete => OpeningPoll::Complete(Err(protocol("opening probe already complete"))),
        }
    }

    /// Execute the outstanding source admission against `element`.
    pub(crate) fn source(
        &self,
        element: &DecodedEntity,
        source: OpeningSource,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> OpeningReply {
        match (source, self.item.as_ref()) {
            (OpeningSource::Probe, _) => OpeningReply::Probe(
                router.opening_probe_source(element, decoder),
                SourceHygiene::BooleanOperand.for_router(router),
                router.world_frame(),
            ),
            // A raw national-grid cutter rebases in this opening's own frame,
            // like the host it cuts (#5698).
            (OpeningSource::RawChoice, Some(item)) => OpeningReply::RawChoice(
                crate::resource::observe(router.raw_item_element_offset(item, element, decoder)),
            ),
            (OpeningSource::Direction, Some(item)) => {
                OpeningReply::Direction(router.extract_extrusion_direction_recursive(item, decoder))
            }
            _ => OpeningReply::Refused(protocol("opening probe source")),
        }
    }

    /// The reached item's canonical item/cache or mapping program. A mapped
    /// source mixing frames yields one cutter per frame (#6446).
    pub(crate) fn child(&self, router: &GeometryRouter) -> Result<OpeningChild<'_>> {
        let item = self.item.as_ref().ok_or_else(|| protocol("opening probe child"))?;
        if item.ifc_type == IfcType::IfcMappedItem {
            return Ok(OpeningChild { program: GeometryProgram::mapped_item(item), parts: true, walk: false });
        }
        let offset = self.offset.unwrap_or_else(|| router.rtc_offset());
        Ok(OpeningChild { program: GeometryProgram::representation_item(item, offset), parts: false, walk: false })
    }

    pub(crate) fn resume(&mut self, reply: OpeningReply) {
        if let Err(error) = self.accept(reply) {
            self.phase = Phase::Complete;
            self.next = Some(OpeningPoll::Complete(Err(error)));
        }
    }

    fn accept(&mut self, reply: OpeningReply) -> Result<()> {
        match reply {
            OpeningReply::Probe(reply, hygiene, frame) => {
                let (items, placement) = reply?;
                self.items = items.into_iter();
                self.state = Some(ProbePlacement {
                    hygiene,
                    placement,
                    frame,
                    meshes: self.meshes,
                    direction: None,
                    placed: Vec::new(),
                    bounds: Vec::new(),
                });
                self.phase = Phase::Item;
            }
            // An ordinary raw-choice or item failure skips only this item.
            OpeningReply::RawChoice(reply) => match reply {
                Ok(offset) => {
                    self.offset = offset;
                    self.next = Some(OpeningPoll::Geometry);
                }
                Err(stop @ Error::ProgramStopped(_)) => return Err(stop),
                Err(_) => self.phase = Phase::Item,
            },
            OpeningReply::Direction(reply) => {
                let value = reply?;
                let placement = self.state.as_ref().ok_or_else(|| protocol("probe state"))?.placement;
                self.next = Some(OpeningPoll::Ready(OpeningReady::ProbeDirection { value, placement }));
            }
            OpeningReply::ProbeDirection(direction) => {
                self.state.as_mut().ok_or_else(|| protocol("probe state"))?.direction = direction;
                self.next = Some(OpeningPoll::Geometry);
            }
            OpeningReply::Parts(reply) => match crate::resource::observe(reply) {
                Ok(parts) => {
                    let placement = self.state.take().ok_or_else(|| protocol("probe state"))?;
                    self.next = Some(OpeningPoll::Ready(OpeningReady::ProbeParts { parts, placement }));
                }
                Err(stop @ Error::ProgramStopped(_)) => return Err(stop),
                Err(_) => self.phase = Phase::Item,
            },
            OpeningReply::ProbeParts(state) => {
                self.state = Some(state);
                self.phase = Phase::Item;
            }
            OpeningReply::Refused(error) => return Err(error),
            _ => return Err(protocol("opening probe reply")),
        }
        Ok(())
    }
}
