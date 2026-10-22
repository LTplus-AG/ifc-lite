// SPDX-License-Identifier: MPL-2.0
//! Parametric rectangle capture for the analytic placement-frame cut. The host
//! and every opening must be exact rectangular extrusions sharing one frame,
//! and each opening's boxes must account for its meshed solid. Any miss
//! captures nothing and the host defers to the exact kernel.
use super::requests::{OpeningReady, OpeningReply, OpeningSource};
use super::{protocol, source_option, OpeningOutput, OpeningPoll};
use crate::program::opening::{OpeningChild, OpeningProgram};
use crate::router::voids::geom::{mesh_signed_volume, signed_permutation_map};
use crate::router::voids::{ParamRectCut, RectParam};
use crate::{GeometryRouter, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix3;

pub(super) struct Capture<'a> {
    element: &'a DecodedEntity,
    ids: std::slice::Iter<'a, u32>,
    requested: u32,
    host: Option<RectParam>,
    openings: Vec<RectParam>,
    current: Option<DecodedEntity>,
    boxes: Vec<RectParam>,
    probe: Option<OpeningProgram>,
    phase: Phase,
    next: Option<OpeningPoll>,
}

#[derive(Clone, Copy)]
enum Phase {
    Host,
    Decode,
    Meshes,
    Waiting,
    Complete,
}

impl<'a> Capture<'a> {
    pub(super) fn new(element: &'a DecodedEntity, ids: &'a [u32]) -> Self {
        Self {
            element,
            ids: ids.iter(),
            requested: 0,
            host: None,
            openings: Vec::new(),
            current: None,
            boxes: Vec::new(),
            probe: None,
            phase: Phase::Host,
            next: None,
        }
    }

    fn finish(&mut self, output: Option<ParamRectCut>) -> OpeningPoll {
        self.phase = Phase::Complete;
        self.current = None;
        OpeningPoll::Complete(Ok(OpeningOutput::Rectangle(output)))
    }

    fn decline(&mut self) {
        let poll = self.finish(None);
        self.next = Some(poll);
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
                        if let Err(error) = self.meshes(output) {
                            self.phase = Phase::Complete;
                            return OpeningPoll::Complete(Err(error));
                        }
                        continue;
                    }
                    poll => return poll,
                }
            }
            match std::mem::replace(&mut self.phase, Phase::Waiting) {
                Phase::Host if self.ids.len() == 0 => return self.finish(None),
                Phase::Host => return OpeningPoll::Source(OpeningSource::RectHost),
                Phase::Decode => {
                    let Some(&id) = self.ids.next() else {
                        let cut = self.host.take().map(|host| ParamRectCut {
                            host,
                            openings: std::mem::take(&mut self.openings),
                        });
                        return self.finish(cut);
                    };
                    self.requested = id;
                    return OpeningPoll::Source(OpeningSource::Decode);
                }
                Phase::Meshes => self.probe = Some(OpeningProgram::new(true)),
                Phase::Waiting => {
                    return OpeningPoll::Complete(Err(protocol("rectangle reply pending")))
                }
                Phase::Complete => {
                    return OpeningPoll::Complete(Err(protocol("rectangle already complete")))
                }
            }
        }
    }

    pub(super) fn source(
        &self,
        source: OpeningSource,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> OpeningReply {
        match (&self.probe, &self.current, source) {
            (Some(probe), Some(current), _) => probe.source(current, source, router, decoder),
            (None, _, OpeningSource::RectHost) => {
                OpeningReply::RectHost(router.parametric_rect_probe(self.element, decoder))
            }
            (None, _, OpeningSource::Decode) => {
                OpeningReply::Decoded(decoder.decode_by_id(self.requested).map_err(Into::into))
            }
            (None, Some(current), OpeningSource::RectBoxes) => {
                OpeningReply::RectBoxes(router.parametric_rect_probe_all(current, decoder))
            }
            _ => OpeningReply::Refused(protocol("rectangle source")),
        }
    }

    pub(super) fn child(&self, router: &GeometryRouter) -> Result<OpeningChild<'_>> {
        match &self.probe {
            Some(probe) => probe.child(router),
            None => Err(protocol("rectangle child")),
        }
    }

    pub(super) fn resume(&mut self, reply: OpeningReply) {
        if let Some(probe) = &mut self.probe {
            return probe.resume(reply);
        }
        if let Err(error) = self.accept(reply) {
            self.phase = Phase::Complete;
            self.next = Some(OpeningPoll::Complete(Err(error)));
        }
    }

    fn accept(&mut self, reply: OpeningReply) -> Result<()> {
        match reply {
            OpeningReply::RectHost(Some(host)) => {
                self.host = Some(host);
                self.openings = Vec::with_capacity(self.ids.len());
                self.phase = Phase::Decode;
            }
            OpeningReply::Decoded(reply) => match source_option(reply)? {
                Some(opening) if opening.ifc_type == IfcType::IfcOpeningElement => {
                    self.current = Some(opening);
                    self.next = Some(OpeningPoll::Source(OpeningSource::RectBoxes));
                }
                _ => self.decline(),
            },
            OpeningReply::RectBoxes(Some(boxes)) => {
                let host = self
                    .host
                    .as_ref()
                    .ok_or_else(|| protocol("rectangle host"))?
                    .r;
                self.next = Some(OpeningPoll::Ready(OpeningReady::RectOrientation {
                    host,
                    boxes,
                }));
            }
            // An empty box set cannot account for the opening: no mesh probe.
            OpeningReply::RectOrientation(Some(boxes)) if !boxes.is_empty() => {
                self.boxes = boxes;
                self.phase = Phase::Meshes;
            }
            OpeningReply::RectReconciled(Some(mut boxes)) => {
                self.openings.append(&mut boxes);
                self.current = None;
                self.phase = Phase::Decode;
            }
            OpeningReply::RectHost(None)
            | OpeningReply::RectBoxes(None)
            | OpeningReply::RectOrientation(_)
            | OpeningReply::RectReconciled(None) => self.decline(),
            OpeningReply::Refused(error) => return Err(error),
            _ => return Err(protocol("rectangle reply")),
        }
        Ok(())
    }

    /// The opening's world item meshes; an ordinary probe failure declines.
    fn meshes(&mut self, output: Result<OpeningOutput>) -> Result<()> {
        match source_option(output)? {
            Some(OpeningOutput::Meshes(meshes)) => {
                let boxes = std::mem::take(&mut self.boxes);
                self.next = Some(OpeningPoll::Ready(OpeningReady::RectReconcile {
                    boxes,
                    meshes,
                }));
            }
            None => self.decline(),
            Some(_) => return Err(protocol("rectangle meshes output")),
        }
        Ok(())
    }
}

/// Every box must map onto the host frame by a signed permutation.
pub(super) fn share_frame(host: &Matrix3<f64>, boxes: Vec<RectParam>) -> Option<Vec<RectParam>> {
    let rt = host.transpose();
    boxes
        .iter()
        .all(|op| signed_permutation_map(&(rt * op.r), 1.0e-3).is_some())
        .then_some(boxes)
}

/// True iff the parametric `boxes` account for the actual meshed opening by
/// VOLUME (Σ box volume ≈ Σ mesh-shell volume within 3%). For a union of
/// non-overlapping rectangular prisms (the Tekla multi-solid opening) the mesh
/// volume equals the box-volume sum; a mismatch flags a non-rect / overlapping
/// / partial part → defer.
pub(super) fn reconcile(boxes: Vec<RectParam>, meshes: &[Mesh]) -> Option<Vec<RectParam>> {
    if boxes.is_empty() {
        return None;
    }
    let mesh_vol: f64 = meshes.iter().map(|m| mesh_signed_volume(m).abs()).sum();
    if mesh_vol < 1.0e-9 {
        return None;
    }
    let box_vol: f64 = boxes
        .iter()
        .map(|b| 8.0 * b.half[0] * b.half[1] * b.half[2])
        .sum();
    let ratio = box_vol / mesh_vol;
    (0.97..1.03).contains(&ratio).then_some(boxes)
}
