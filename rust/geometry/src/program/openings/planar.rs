// SPDX-License-Identifier: MPL-2.0
//! Source profile capture followed by geometry-only footprint admission.
use crate::router::voids::{
    bool2d_path::{
        footprint::{footprint_interior, opening_solid_footprint},
        Bool2dCut,
    },
    probe::ExtrudedSolidInfo,
    VoidContext,
};
use crate::{resource, GeometryRouter};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Matrix4, Point2, Vector3};

pub(super) struct Capture {
    host: ExtrudedSolidInfo,
    ids: std::vec::IntoIter<u32>,
    hm_inv: Matrix4<f64>,
    host_axis: Vector3<f64>,
    hz_min: f64,
    hz_max: f64,
    z_tol: f64,
    footprints: Vec<Vec<Point2<f64>>>,
    residual_ids: Vec<u32>,
}
impl Capture {
    pub(super) fn run(
        element: &DecodedEntity,
        ids: &[u32],
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> crate::Result<Option<Bool2dCut>> {
        resource::check_current()?;
        if ids.is_empty() {
            return Ok(None);
        }
        let host = router.host_extruded_solid_checked(element, decoder)?;
        resource::check_current()?;
        let Some(host) = host else { return Ok(None) };
        let Some(hm_inv) = host.m.try_inverse() else { return Ok(None) };
        let host_rot = host.m.fixed_view::<3, 3>(0, 0).into_owned();
        let Some(host_axis) = (host_rot * Vector3::new(0.0, 0.0, host.dir_sign)).try_normalize(1e-9) else {
            return Ok(None);
        };
        // Host extrusion span in the solid's profile frame.
        let (hz_min, hz_max) = if host.dir_sign >= 0.0 {
            (0.0, host.depth)
        } else {
            (-host.depth, 0.0)
        };
        // Numerical-precision coincidence (1 ppm): near-through blind openings
        // defer to the exact kernel instead of becoming a full-depth hole.
        let z_tol = 1.0e-6 * host.depth.abs() + 1.0e-9;

        let mut capture = Self {
            host,
            ids: ids.to_vec().into_iter(),
            hm_inv,
            host_axis,
            hz_min,
            hz_max,
            z_tol,
            footprints: Vec::new(),
            residual_ids: Vec::new(),
        };
        while let Some(id) = capture.ids.next() {
            resource::check_current()?;
            let decoded = decoder.decode_by_id(id);
            resource::check_current()?;
            match decoded {
                Ok(opening) if opening.ifc_type == IfcType::IfcOpeningElement => {
                    capture.opening(id, &opening, router, decoder)?
                }
                _ => capture.residual_ids.push(id),
            }
        }
        capture.finish(element, router, decoder)
    }
    fn opening(
        &mut self,
        oid: u32,
        opening: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> crate::Result<()> {
        resource::check_current()?;
        // An opening is eligible only when EVERY constituent solid is a
        // parallel through-cut whose hole-free footprint lands STRICTLY
        // INTERIOR to the host profile. A footprint that touches / breaches
        // the boundary, or lands in an existing profile hole, is routed to
        // the residual so it never silently no-ops. Collect tentatively; any
        // ineligible solid sends the
        // whole opening (all its solids) to the residual so nothing is
        // double-cut.
        let mut opening_footprints: Vec<Vec<Point2<f64>>> = Vec::new();
        let solids = router.opening_extruded_solids_checked(opening, decoder)?;
        resource::check_current()?;
        let mut eligible = solids.is_some();
        if let Some(solids) = solids {
            for op in &solids {
                resource::check_current()?;
                let footprint = opening_solid_footprint(
                    op,
                    &self.hm_inv,
                    &self.host_axis,
                    self.hz_min,
                    self.hz_max,
                    self.z_tol,
                );
                resource::check_current()?;
                match footprint {
                    Some(fp) if footprint_interior(&fp, &self.host.profile) => {
                        resource::check_current()?;
                        opening_footprints.push(fp);
                    }
                    _ => {
                        eligible = false;
                        break;
                    }
                }
            }
        }
        resource::check_current()?;
        if eligible && !opening_footprints.is_empty() {
            self.footprints.append(&mut opening_footprints);
        } else {
            self.residual_ids.push(oid);
        }
        Ok(())
    }
    fn finish(
        self,
        element: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> crate::Result<Option<Bool2dCut>> {
        resource::check_current()?;
        if self.footprints.is_empty() {
            return Ok(None);
        }
        // Profile-local → world metres, RTC-relative: world = scale·(m·p) − rtc.
        // Scaling rows 0..3 (incl. their translation column) then subtracting the
        // RTC offset reproduces `center_native · s − rtc` from the rect probe.
        let s = router.unit_scale();
        let (rx, ry, rz) = router.rtc_offset();
        let mut wt = self.host.m;
        for i in 0..3 {
            for j in 0..4 {
                wt[(i, j)] *= s;
            }
        }
        wt[(0, 3)] -= rx;
        wt[(1, 3)] -= ry;
        wt[(2, 3)] -= rz;

        resource::check_current()?;
        let residual = if self.residual_ids.is_empty() {
            None
        } else {
            let openings =
                super::Classifier::new(element, &self.residual_ids, false).run(router, decoder)?;
            if openings.is_empty() {
                None
            } else {
                let merged_openings = GeometryRouter::merge_rectangular_openings(&openings);
                Some(Box::new(VoidContext {
                    openings,
                    merged_openings,
                    param: None,
                    bool2d: None,
                }))
            }
        };
        resource::check_current()?;
        Ok(Some(Bool2dCut {
            host_profile: self.host.profile,
            depth: self.host.depth,
            dir_sign: self.host.dir_sign,
            wt,
            footprints: self.footprints,
            residual,
        }))
    }
}
