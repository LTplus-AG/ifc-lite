// SPDX-License-Identifier: MPL-2.0
//! Rectangle probes and actual-mesh reconciliation are independently consumed.
use super::control::{OpeningControl, OpeningOutput, OpeningPoll, Step};
use super::requests::{OpeningReady, OpeningReply, OpeningSource};
use crate::router::voids::{ParamRectCut, RectParam};
use crate::Result;
use ifc_lite_core::{DecodedEntity, IfcType};

pub(super) struct Capture {
    element: DecodedEntity,
    ids: std::vec::IntoIter<u32>,
    host: Option<RectParam>,
    openings: Vec<RectParam>,
    current: Option<DecodedEntity>,
    boxes: Vec<RectParam>,
    next: Option<OpeningPoll>,
    phase: Phase,
}
enum Phase {
    Host,
    Decode,
    Meshes,
    Pending,
}
impl Capture {
    pub(super) fn new(element: DecodedEntity, ids: Vec<u32>) -> Self {
        let capacity = ids.len();
        Self {
            element,
            ids: ids.into_iter(),
            host: None,
            openings: Vec::with_capacity(capacity),
            current: None,
            boxes: Vec::new(),
            next: None,
            phase: Phase::Host,
        }
    }
    pub(super) fn poll(&mut self) -> Step {
        if let Some(next) = self.next.take() {
            return Step::Poll(next);
        }
        let phase = std::mem::replace(&mut self.phase, Phase::Pending);
        match phase {
            Phase::Host => {
                if self.ids.len() == 0 {
                    self.finish(None);
                    return self.poll();
                }
                Step::Poll(OpeningPoll::Source(OpeningSource::RectHost(
                    self.element.clone(),
                )))
            }
            Phase::Decode => {
                if let Some(id) = self.ids.next() {
                    Step::Poll(OpeningPoll::Source(OpeningSource::Decode(id)))
                } else {
                    let cut = ParamRectCut {
                        host: self.host.take().expect("rectangle host"),
                        openings: std::mem::take(&mut self.openings),
                    };
                    self.finish(Some(cut));
                    self.poll()
                }
            }
            Phase::Meshes => Step::Child(OpeningControl::probe(
                self.current.as_ref().expect("rectangle opening").clone(),
                true,
            )),
            Phase::Pending => Step::Poll(OpeningPoll::Pending),
        }
    }
    fn finish(&mut self, output: Option<ParamRectCut>) {
        self.next = Some(OpeningPoll::Ready(OpeningReady::Finish(
            OpeningOutput::Rectangle(output),
        )));
    }
    pub(super) fn resume(&mut self, reply: OpeningReply) -> Result<()> {
        match reply {
            OpeningReply::RectHost(reply) => match reply? {
                Some(host) => {
                    self.host = Some(host);
                    self.phase = Phase::Decode
                }
                None => self.finish(None),
            },
            OpeningReply::Decoded(reply) => match super::source_option(reply)? {
                Some(opening) if opening.ifc_type == IfcType::IfcOpeningElement => {
                    self.next = Some(OpeningPoll::Source(OpeningSource::RectBoxes(
                        opening.clone(),
                    )));
                    self.current = Some(opening);
                }
                _ => self.finish(None),
            },
            OpeningReply::RectBoxes(reply) => match reply? {
                Some(boxes) => {
                    self.next = Some(OpeningPoll::Ready(OpeningReady::RectOrientation {
                        host: self.host.as_ref().expect("rectangle host").r,
                        boxes,
                    }))
                }
                None => self.finish(None),
            },
            OpeningReply::RectOrientation(boxes) => match boxes {
                Some(boxes) if !boxes.is_empty() => {
                    self.boxes = boxes;
                    self.phase = Phase::Meshes;
                }
                _ => self.finish(None),
            },
            OpeningReply::RectReconciled(boxes) => match boxes {
                Some(mut boxes) => {
                    self.openings.append(&mut boxes);
                    self.current = None;
                    self.phase = Phase::Decode
                }
                None => self.finish(None),
            },
            OpeningReply::Finished(output) => self.next = Some(OpeningPoll::Complete(Ok(output))),
            _ => unreachable!("rectangle reply tag"),
        }
        Ok(())
    }
    pub(super) fn child_complete(&mut self, output: Result<OpeningOutput>) -> Result<()> {
        match super::source_option(output)? {
            Some(OpeningOutput::Meshes(meshes)) => {
                self.next = Some(OpeningPoll::Ready(OpeningReady::RectReconcile {
                    boxes: std::mem::take(&mut self.boxes),
                    meshes,
                }))
            }
            None => self.finish(None),
            _ => unreachable!("rectangle meshes output"),
        }
        Ok(())
    }
}
