// SPDX-License-Identifier: MPL-2.0
//! Opening probes are reached list/source admissions and canonical item children.
use super::openings::control::{OpeningControl, OpeningOutput, OpeningPoll, Step};
use super::openings::requests::{OpeningChild, OpeningReady, OpeningReply, OpeningSource};
use super::traversal::TraversalPoll;
use super::{EntryPolicy, ProductProgram};
use crate::router::transforms::WorldFrame;
use crate::{GeometryRouter, Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

pub(crate) type OpeningBounds = Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)>;
pub(crate) struct OpeningProgram {
    element: DecodedEntity,
    meshes: bool,
    items: Option<ProductProgram>,
    placement: Matrix4<f64>,
    frame: Option<WorldFrame>,
    item: Option<DecodedEntity>,
    direction: Option<Vector3<f64>>,
    output: Vec<Mesh>,
    bounds: OpeningBounds,
    next: Option<OpeningPoll>,
    complete: bool,
}
impl OpeningProgram {
    pub(crate) fn new(element: DecodedEntity, meshes: bool) -> Self {
        let next = Some(OpeningPoll::Source(OpeningSource::Representations {
            element: element.clone(),
            meshes,
        }));
        Self {
            element,
            meshes,
            items: None,
            placement: Matrix4::identity(),
            frame: None,
            item: None,
            direction: None,
            output: Vec::new(),
            bounds: Vec::new(),
            next,
            complete: false,
        }
    }
    pub(super) fn poll(&mut self) -> Step {
        if let Some(next) = self.next.take() {
            return Step::Poll(next);
        }
        if self.complete {
            return Step::Poll(OpeningPoll::Pending);
        }
        let Some(items) = &mut self.items else {
            return Step::Poll(OpeningPoll::Pending);
        };
        match items.poll() {
            TraversalPoll::Items(request) => {
                Step::Poll(OpeningPoll::Source(OpeningSource::Items(request)))
            }
            TraversalPoll::Item(reached) => {
                self.item = Some(reached.item.clone());
                self.direction = None;
                Step::Poll(OpeningPoll::Source(if self.meshes {
                    OpeningSource::RawChoice {
                        element: self.element.clone(),
                        item: reached.item,
                    }
                } else {
                    OpeningSource::Direction(reached.item)
                }))
            }
            TraversalPoll::Complete => {
                self.complete = true;
                Step::Poll(OpeningPoll::Complete(Ok(if self.meshes {
                    OpeningOutput::Meshes(std::mem::take(&mut self.output))
                } else {
                    OpeningOutput::Bounds(std::mem::take(&mut self.bounds))
                })))
            }
            TraversalPoll::Pending => Step::Poll(OpeningPoll::Pending),
        }
    }
    pub(super) fn resume(&mut self, reply: OpeningReply, router: &GeometryRouter) -> Result<()> {
        match reply {
            OpeningReply::Representations(reply) => match reply? {
                Some(items) => {
                    self.items = Some(items);
                    self.next = Some(OpeningPoll::Source(OpeningSource::Placement(
                        self.element.clone(),
                    )));
                }
                None => {
                    self.complete = true;
                    self.next = Some(OpeningPoll::Complete(Ok(if self.meshes {
                        OpeningOutput::Meshes(Vec::new())
                    } else {
                        OpeningOutput::Bounds(Vec::new())
                    })));
                }
            },
            OpeningReply::Placement(reply) => {
                let (placement, scale, frame) = reply?;
                self.next = Some(OpeningPoll::Ready(OpeningReady::ProbePlacement {
                    placement,
                    scale,
                    frame,
                }));
            }
            OpeningReply::ProbePlacement(placement, frame) => {
                self.placement = placement;
                self.frame = Some(frame);
            }
            OpeningReply::Items(reply) => self
                .items
                .as_mut()
                .expect("opening traversal")
                .accept_items(reply)?,
            OpeningReply::RawChoice(reply) => match crate::resource::observe(reply) {
                Ok(offset) => {
                    self.next = Some(OpeningPoll::Geometry(OpeningChild::Item {
                        item: self.item.take().expect("reached opening item"),
                        offset,
                    }))
                }
                Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
                Err(_) => {}
            },
            OpeningReply::Direction(reply) => {
                let value = reply?;
                self.next = Some(OpeningPoll::Ready(OpeningReady::ProbeDirection {
                    value,
                    placement: self.placement,
                }));
            }
            OpeningReply::ProbeDirection(direction) => {
                self.direction = direction;
                self.next = Some(OpeningPoll::Geometry(OpeningChild::Item {
                    item: self.item.take().expect("reached opening item"),
                    offset: None,
                }));
            }
            OpeningReply::Parts(reply) => match crate::resource::observe(reply) {
                Ok(parts) => {
                    self.next = Some(OpeningPoll::Ready(OpeningReady::ProbeParts {
                        parts,
                        hygiene: crate::router::processing::SourceHygiene::BooleanOperand.for_router(router),
                        placement: self.placement,
                        frame: self.frame.expect("admitted placement frame"),
                        meshes: self.meshes,
                        direction: self.direction,
                    }))
                }
                Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
                Err(_) => {}
            },
            OpeningReply::ProbeParts(mut meshes, mut bounds) => {
                self.output.append(&mut meshes);
                self.bounds.append(&mut bounds);
            }
            _ => unreachable!("opening probe reply tag"),
        }
        Ok(())
    }
    /// Borrowed API compatibility: constructing control performs no IFC read.
    pub(crate) fn admit(
        element: &DecodedEntity,
        policy: EntryPolicy,
        _router: &GeometryRouter,
        _decoder: &mut EntityDecoder<'_>,
    ) -> Result<Option<Self>> {
        crate::resource::check_current()?;
        Ok(Some(Self::new(
            element.clone(),
            matches!(policy, EntryPolicy::OpeningItemMeshes),
        )))
    }
    pub(crate) fn meshes(
        self,
        _element: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<Vec<Mesh>> {
        match OpeningControl::from_probe(self).drain(router, decoder)? {
            OpeningOutput::Meshes(meshes) => Ok(meshes),
            _ => unreachable!("opening meshes output"),
        }
    }
    pub(crate) fn bounds(
        self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<OpeningBounds> {
        match OpeningControl::from_probe(self).drain(router, decoder)? {
            OpeningOutput::Bounds(bounds) => Ok(bounds),
            _ => unreachable!("opening bounds output"),
        }
    }
}
