// SPDX-License-Identifier: MPL-2.0
//! Source solids, per-solid numerical eligibility, then quiet residual children.
use super::control::{OpeningControl, OpeningOutput, OpeningPoll, Step};
use super::requests::{OpeningReady, OpeningReply, OpeningSource};
use crate::router::voids::{bool2d_path::Bool2dCut, probe::ExtrudedSolidInfo, VoidContext};
use crate::Result;
use ifc_lite_core::{DecodedEntity, IfcType};
use nalgebra::{Matrix4, Point2, Vector3};
use std::sync::Arc;

pub(crate) struct PlanarHost {
    pub(super) solid: ExtrudedSolidInfo,
    pub(super) hm_inv: Matrix4<f64>,
    pub(super) axis: Vector3<f64>,
    pub(super) z_min: f64,
    pub(super) z_max: f64,
    pub(super) z_tol: f64,
}
impl PlanarHost {
    pub(super) fn prepare(solid: ExtrudedSolidInfo) -> Option<Self> {
        let hm_inv = solid.m.try_inverse()?;
        let rotation = solid.m.fixed_view::<3, 3>(0, 0).into_owned();
        let axis = (rotation * Vector3::new(0.0, 0.0, solid.dir_sign)).try_normalize(1e-9)?;
        let (z_min, z_max) = if solid.dir_sign >= 0.0 {
            (0.0, solid.depth)
        } else {
            (-solid.depth, 0.0)
        };
        let z_tol = 1.0e-6 * solid.depth.abs() + 1.0e-9;
        Some(Self {
            solid,
            hm_inv,
            axis,
            z_min,
            z_max,
            z_tol,
        })
    }
}
pub(super) struct Capture {
    element: DecodedEntity,
    ids: std::vec::IntoIter<u32>,
    host: Option<Arc<PlanarHost>>,
    requested: u32,
    solids: std::vec::IntoIter<ExtrudedSolidInfo>,
    tentative: Vec<Vec<Point2<f64>>>,
    footprints: Vec<Vec<Point2<f64>>>,
    residual_ids: Vec<u32>,
    wt: Option<Matrix4<f64>>,
    residual: Option<Box<VoidContext>>,
    next: Option<OpeningPoll>,
    phase: Phase,
}
enum Phase {
    Host,
    Decode,
    Footprints,
    Residual,
    Pending,
}
impl Capture {
    pub(super) fn new(element: DecodedEntity, ids: Vec<u32>) -> Self {
        Self {
            element,
            ids: ids.into_iter(),
            host: None,
            requested: 0,
            solids: Vec::new().into_iter(),
            tentative: Vec::new(),
            footprints: Vec::new(),
            residual_ids: Vec::new(),
            wt: None,
            residual: None,
            next: None,
            phase: Phase::Host,
        }
    }
    pub(super) fn poll(&mut self) -> Step {
        if let Some(next) = self.next.take() {
            return Step::Poll(next);
        }
        match std::mem::replace(&mut self.phase, Phase::Pending) {
            Phase::Host => {
                if self.ids.len() == 0 {
                    self.finish_none();
                    return self.poll();
                }
                Step::Poll(OpeningPoll::Source(OpeningSource::SolidHost(
                    self.element.clone(),
                )))
            }
            Phase::Decode => {
                if let Some(id) = self.ids.next() {
                    self.requested = id;
                    Step::Poll(OpeningPoll::Source(OpeningSource::Decode(id)))
                } else if self.footprints.is_empty() {
                    self.finish_none();
                    self.poll()
                } else {
                    Step::Poll(OpeningPoll::Source(OpeningSource::Frame))
                }
            }
            Phase::Footprints => {
                if let Some(solid) = self.solids.next() {
                    Step::Poll(OpeningPoll::Ready(OpeningReady::Footprint {
                        host: Arc::clone(self.host.as_ref().expect("planar host")),
                        solid,
                    }))
                } else {
                    if self.tentative.is_empty() {
                        self.residual_ids.push(self.requested)
                    } else {
                        self.footprints.append(&mut self.tentative)
                    }
                    self.phase = Phase::Decode;
                    self.poll()
                }
            }
            Phase::Residual => {
                if self.residual_ids.is_empty() {
                    self.finish();
                    self.poll()
                } else {
                    Step::Child(OpeningControl::classifier(
                        self.element.clone(),
                        std::mem::take(&mut self.residual_ids),
                        false,
                    ))
                }
            }
            Phase::Pending => Step::Poll(OpeningPoll::Pending),
        }
    }
    fn finish_none(&mut self) {
        self.next = Some(OpeningPoll::Ready(OpeningReady::Finish(
            OpeningOutput::Planar(None),
        )));
    }
    fn finish(&mut self) {
        let host = Arc::into_inner(self.host.take().expect("planar host"))
            .unwrap_or_else(|| panic!("pending planar recipe retains host"));
        let cut = Bool2dCut {
            host_profile: host.solid.profile,
            depth: host.solid.depth,
            dir_sign: host.solid.dir_sign,
            wt: self.wt.take().expect("planar world transform"),
            footprints: std::mem::take(&mut self.footprints),
            residual: self.residual.take(),
        };
        self.next = Some(OpeningPoll::Ready(OpeningReady::Finish(
            OpeningOutput::Planar(Some(cut)),
        )));
    }
    pub(super) fn resume(&mut self, reply: OpeningReply) -> Result<()> {
        match reply {
            OpeningReply::SolidHost(reply) => match reply? {
                Some(host) => self.next = Some(OpeningPoll::Ready(OpeningReady::PlanarHost(host))),
                None => self.finish_none(),
            },
            OpeningReply::PlanarHost(host) => match host {
                Some(host) => {
                    self.host = Some(host);
                    self.phase = Phase::Decode
                }
                None => self.finish_none(),
            },
            OpeningReply::Decoded(reply) => match super::source_option(reply)? {
                Some(opening) if opening.ifc_type == IfcType::IfcOpeningElement => {
                    self.next = Some(OpeningPoll::Source(OpeningSource::Solids(opening)))
                }
                _ => {
                    self.residual_ids.push(self.requested);
                    self.phase = Phase::Decode;
                }
            },
            OpeningReply::Solids(reply) => match reply? {
                Some(solids) => {
                    self.solids = solids.into_iter();
                    self.tentative.clear();
                    self.phase = Phase::Footprints
                }
                None => {
                    self.residual_ids.push(self.requested);
                    self.phase = Phase::Decode;
                }
            },
            OpeningReply::Footprint(footprint) => match footprint {
                Some(footprint) => {
                    self.tentative.push(footprint);
                    self.phase = Phase::Footprints
                }
                None => {
                    self.residual_ids.push(self.requested);
                    self.tentative.clear();
                    self.solids = Vec::new().into_iter();
                    self.phase = Phase::Decode;
                }
            },
            OpeningReply::Frame(scale, rtc) => {
                self.next = Some(OpeningPoll::Ready(OpeningReady::PlanarTransform {
                    host: Arc::clone(self.host.as_ref().expect("planar host")),
                    scale,
                    rtc,
                }))
            }
            OpeningReply::PlanarTransform(wt) => {
                self.wt = Some(wt);
                self.phase = Phase::Residual
            }
            OpeningReply::Merged(openings, merged_openings) => {
                self.residual = Some(Box::new(VoidContext {
                    openings,
                    merged_openings,
                    param: None,
                    bool2d: None,
                }));
                self.finish();
            }
            OpeningReply::Finished(output) => self.next = Some(OpeningPoll::Complete(Ok(output))),
            _ => unreachable!("planar reply tag"),
        }
        Ok(())
    }
    pub(super) fn child_complete(&mut self, output: Result<OpeningOutput>) -> Result<()> {
        match output? {
            OpeningOutput::Classified(openings) => {
                if openings.is_empty() {
                    self.finish()
                } else {
                    self.next = Some(OpeningPoll::Ready(OpeningReady::Merge(openings)));
                }
            }
            _ => unreachable!("quiet residual classifier output"),
        }
        Ok(())
    }
}
