// SPDX-License-Identifier: MPL-2.0
//! Planar (2D opening-subtraction) capture. The host must be one clean
//! extrusion; each opening whose every solid is a parallel through-cut
//! landing strictly inside the host profile contributes footprints, and every
//! other requested id is classified by a QUIET residual pass for the exact
//! kernel. No eligible footprint captures nothing.
use super::classify::Classifier;
use super::requests::{OpeningReady, OpeningReply, OpeningSource};
use super::{protocol, source_option, OpeningOutput, OpeningPoll};
use crate::program::opening::OpeningChild;
use crate::router::voids::bool2d_path::{footprint_interior, opening_solid_footprint, Bool2dCut};
use crate::router::voids::probe::ExtrudedSolidInfo;
use crate::router::voids::VoidContext;
use crate::{GeometryRouter, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Matrix4, Point2, Vector3};

/// The host solid with its inverse frame and extrusion span, moved through
/// each footprint packet rather than shared.
pub(crate) struct PlanarHost {
    solid: ExtrudedSolidInfo,
    hm_inv: Matrix4<f64>,
    axis: Vector3<f64>,
    z_min: f64,
    z_max: f64,
    z_tol: f64,
}

impl PlanarHost {
    pub(super) fn prepare(solid: ExtrudedSolidInfo) -> Option<Self> {
        let hm_inv = solid.m.try_inverse()?;
        let rotation = solid.m.fixed_view::<3, 3>(0, 0).into_owned();
        let axis = (rotation * Vector3::new(0.0, 0.0, solid.dir_sign)).try_normalize(1e-9)?;
        // Host extrusion span in the solid's profile frame.
        let (z_min, z_max) = if solid.dir_sign >= 0.0 {
            (0.0, solid.depth)
        } else {
            (-solid.depth, 0.0)
        };
        // Numerical-precision coincidence (1 ppm): near-through blind openings
        // defer to the exact kernel instead of becoming a full-depth hole.
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

    /// A parallel through-cut footprint strictly interior to the host profile.
    pub(super) fn footprint(&self, solid: &ExtrudedSolidInfo) -> Option<Vec<Point2<f64>>> {
        let fp = opening_solid_footprint(
            solid,
            &self.hm_inv,
            &self.axis,
            self.z_min,
            self.z_max,
            self.z_tol,
        )?;
        footprint_interior(&fp, &self.solid.profile).then_some(fp)
    }
}

/// Profile-local → world metres, RTC-relative: world = scale·(m·p) − rtc.
/// Scaling rows 0..3 (incl. their translation column) then subtracting the RTC
/// offset reproduces `center_native · s − rtc` from the rect probe.
pub(super) fn world_transform(
    m: Matrix4<f64>,
    s: f64,
    (rx, ry, rz): (f64, f64, f64),
) -> Matrix4<f64> {
    let mut wt = m;
    for i in 0..3 {
        for j in 0..4 {
            wt[(i, j)] *= s;
        }
    }
    wt[(0, 3)] -= rx;
    wt[(1, 3)] -= ry;
    wt[(2, 3)] -= rz;
    wt
}

pub(super) struct Capture<'a> {
    element: &'a DecodedEntity,
    ids: std::slice::Iter<'a, u32>,
    requested: u32,
    host: Option<PlanarHost>,
    current: Option<DecodedEntity>,
    solids: std::vec::IntoIter<ExtrudedSolidInfo>,
    /// One opening's footprints, kept only if every solid is eligible.
    tentative: Vec<Vec<Point2<f64>>>,
    footprints: Vec<Vec<Point2<f64>>>,
    residual_ids: Vec<u32>,
    wt: Option<Matrix4<f64>>,
    residual: Option<Classifier<'a>>,
    phase: Phase,
    next: Option<OpeningPoll>,
}

#[derive(Clone, Copy)]
enum Phase {
    Host,
    Decode,
    Footprints,
    Residual,
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
            current: None,
            solids: Vec::new().into_iter(),
            tentative: Vec::new(),
            footprints: Vec::new(),
            residual_ids: Vec::new(),
            wt: None,
            residual: None,
            phase: Phase::Host,
            next: None,
        }
    }

    fn complete(&mut self, output: Result<OpeningOutput>) -> OpeningPoll {
        self.phase = Phase::Complete;
        OpeningPoll::Complete(output)
    }

    fn decline(&mut self) {
        let poll = self.complete(Ok(OpeningOutput::Planar(None)));
        self.next = Some(poll);
    }

    fn finish(&mut self, residual: Option<Box<VoidContext>>) -> Result<()> {
        let host = self.host.take().ok_or_else(|| protocol("planar host"))?;
        let wt = self.wt.take().ok_or_else(|| protocol("planar transform"))?;
        let cut = Bool2dCut {
            host_profile: host.solid.profile,
            depth: host.solid.depth,
            dir_sign: host.solid.dir_sign,
            wt,
            footprints: std::mem::take(&mut self.footprints),
            residual,
        };
        let poll = self.complete(Ok(OpeningOutput::Planar(Some(cut))));
        self.next = Some(poll);
        Ok(())
    }

    /// The reached opening goes to the exact kernel, all its solids together.
    fn send_to_residual(&mut self) {
        self.residual_ids.push(self.requested);
        self.current = None;
        self.tentative.clear();
        self.solids = Vec::new().into_iter();
        self.phase = Phase::Decode;
    }

    pub(super) fn poll(&mut self) -> OpeningPoll {
        loop {
            if let Some(next) = self.next.take() {
                return next;
            }
            if let Some(residual) = &mut self.residual {
                match residual.poll() {
                    OpeningPoll::Complete(output) => {
                        self.residual = None;
                        if let Err(error) = self.residual_complete(output) {
                            return self.complete(Err(error));
                        }
                        continue;
                    }
                    poll => return poll,
                }
            }
            match std::mem::replace(&mut self.phase, Phase::Waiting) {
                Phase::Host if self.ids.len() == 0 => {
                    return self.complete(Ok(OpeningOutput::Planar(None)))
                }
                Phase::Host => return OpeningPoll::Source(OpeningSource::SolidHost),
                Phase::Decode => match self.ids.next() {
                    Some(&id) => {
                        self.requested = id;
                        return OpeningPoll::Source(OpeningSource::Decode);
                    }
                    None if self.footprints.is_empty() => {
                        return self.complete(Ok(OpeningOutput::Planar(None)))
                    }
                    None => return OpeningPoll::Source(OpeningSource::Frame),
                },
                Phase::Footprints => match (self.solids.next(), self.host.take()) {
                    (Some(solid), Some(host)) => {
                        return OpeningPoll::Ready(OpeningReady::Footprint { host, solid })
                    }
                    (Some(_), None) => return self.complete(Err(protocol("planar host"))),
                    (None, host) => {
                        self.host = host;
                        if self.tentative.is_empty() {
                            self.send_to_residual();
                        } else {
                            self.footprints.append(&mut self.tentative);
                            self.current = None;
                            self.phase = Phase::Decode;
                        }
                    }
                },
                Phase::Residual if self.residual_ids.is_empty() => {
                    if let Err(error) = self.finish(None) {
                        return self.complete(Err(error));
                    }
                }
                Phase::Residual => {
                    let ids = std::mem::take(&mut self.residual_ids);
                    self.residual = Some(Classifier::residual(self.element, ids));
                }
                Phase::Waiting => {
                    return OpeningPoll::Complete(Err(protocol("planar reply pending")))
                }
                Phase::Complete => {
                    return OpeningPoll::Complete(Err(protocol("planar already complete")))
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
        if let Some(residual) = &self.residual {
            return residual.source(source, router, decoder);
        }
        match (source, &self.current) {
            (OpeningSource::SolidHost, _) => {
                OpeningReply::SolidHost(router.host_extruded_solid(self.element, decoder))
            }
            (OpeningSource::Decode, _) => {
                OpeningReply::Decoded(decoder.decode_by_id(self.requested).map_err(Into::into))
            }
            (OpeningSource::Solids, Some(opening)) => {
                OpeningReply::Solids(router.opening_extruded_solids(opening, decoder))
            }
            (OpeningSource::Frame, _) => {
                OpeningReply::Frame(router.unit_scale(), router.rtc_offset())
            }
            _ => OpeningReply::Refused(protocol("planar source")),
        }
    }

    pub(super) fn child(&self, router: &GeometryRouter) -> Result<OpeningChild<'_>> {
        match &self.residual {
            Some(residual) => residual.child(router),
            None => Err(protocol("planar child")),
        }
    }

    pub(super) fn resume(&mut self, reply: OpeningReply, router: &GeometryRouter) {
        if let Some(residual) = &mut self.residual {
            return residual.resume(reply, router);
        }
        if let Err(error) = self.accept(reply) {
            let poll = self.complete(Err(error));
            self.next = Some(poll);
        }
    }

    fn accept(&mut self, reply: OpeningReply) -> Result<()> {
        match reply {
            OpeningReply::SolidHost(Some(solid)) => {
                self.next = Some(OpeningPoll::Ready(OpeningReady::PlanarHost(solid)));
            }
            OpeningReply::PlanarHost(Some(host)) => {
                self.host = Some(host);
                self.phase = Phase::Decode;
            }
            OpeningReply::SolidHost(None) | OpeningReply::PlanarHost(None) => self.decline(),
            // A non-opening (or undecodable) id goes to the exact kernel.
            OpeningReply::Decoded(reply) => match source_option(reply)? {
                Some(opening) if opening.ifc_type == IfcType::IfcOpeningElement => {
                    self.current = Some(opening);
                    self.next = Some(OpeningPoll::Source(OpeningSource::Solids));
                }
                _ => self.send_to_residual(),
            },
            OpeningReply::Solids(Some(solids)) => {
                self.solids = solids.into_iter();
                self.tentative.clear();
                self.phase = Phase::Footprints;
            }
            OpeningReply::Solids(None) => self.send_to_residual(),
            OpeningReply::Footprint(host, footprint) => {
                self.host = Some(host);
                match footprint {
                    Some(footprint) => {
                        self.tentative.push(footprint);
                        self.phase = Phase::Footprints;
                    }
                    None => self.send_to_residual(),
                }
            }
            OpeningReply::Frame(scale, rtc) => {
                let placement = self
                    .host
                    .as_ref()
                    .ok_or_else(|| protocol("planar host"))?
                    .solid
                    .m;
                self.next = Some(OpeningPoll::Ready(OpeningReady::PlanarTransform {
                    placement,
                    scale,
                    rtc,
                }));
            }
            OpeningReply::PlanarTransform(wt) => {
                self.wt = Some(wt);
                self.phase = Phase::Residual;
            }
            OpeningReply::Merged(openings, merged_openings) => {
                self.finish(Some(Box::new(VoidContext {
                    openings,
                    merged_openings,
                    param: None,
                    bool2d: None,
                })))?;
            }
            OpeningReply::Refused(error) => return Err(error),
            _ => return Err(protocol("planar reply")),
        }
        Ok(())
    }

    /// The quiet residual classification. An ordinary fault declines the whole
    /// planar capture; a typed stop is returned.
    fn residual_complete(&mut self, output: Result<OpeningOutput>) -> Result<()> {
        match source_option(output)? {
            Some(OpeningOutput::Classified(openings)) if openings.is_empty() => {
                self.finish(None)?
            }
            Some(OpeningOutput::Classified(openings)) => {
                self.next = Some(OpeningPoll::Ready(OpeningReady::Merge(openings)));
            }
            None => self.decline(),
            Some(_) => return Err(protocol("planar residual output")),
        }
        Ok(())
    }
}
