// SPDX-License-Identifier: MPL-2.0
//! Owned rectangle capture and reconciliation against actual runtime meshes.
use crate::router::voids::{
    geom::{mesh_signed_volume, signed_permutation_map},
    ParamRectCut, RectParam,
};
use crate::{resource, GeometryRouter};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

pub(super) struct Capture {
    host: RectParam,
    ids: std::vec::IntoIter<u32>,
    openings: Vec<RectParam>,
    current: Option<DecodedEntity>,
    boxes: Vec<RectParam>,
}
impl Capture {
    pub(super) fn run(
        element: &DecodedEntity,
        ids: &[u32],
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> crate::Result<Option<ParamRectCut>> {
        resource::check_current()?;
        if ids.is_empty() {
            return Ok(None);
        }
        let host = router.parametric_rect_probe_checked(element, decoder)?;
        resource::check_current()?;
        let Some(host) = host else { return Ok(None) };
        let mut capture = Self {
            host,
            ids: ids.to_vec().into_iter(),
            openings: Vec::with_capacity(ids.len()),
            current: None,
            boxes: Vec::new(),
        };
        while let Some(id) = capture.ids.next() {
            resource::check_current()?;
            let opening = decoder.decode_by_id(id);
            resource::check_current()?;
            let Ok(opening) = opening else { return Ok(None) };
            capture.current = Some(opening);
            if capture.capture_boxes(router, decoder)?.is_none() {
                return Ok(None);
            }
            if capture.reconcile(router, decoder)?.is_none() {
                return Ok(None);
            }
            resource::check_current()?;
            capture.openings.append(&mut capture.boxes);
            capture.current = None;
        }
        resource::check_current()?;
        Ok(Some(ParamRectCut {
            host: capture.host,
            openings: capture.openings,
        }))
    }
    fn capture_boxes(
        &mut self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> crate::Result<Option<()>> {
        resource::check_current()?;
        let Some(opening) = self.current.as_ref() else { return Ok(None) };
        if opening.ifc_type != IfcType::IfcOpeningElement {
            return Ok(None);
        }
        let boxes = router.parametric_rect_probe_all_checked(opening, decoder)?;
        resource::check_current()?;
        let Some(boxes) = boxes else { return Ok(None) };
        self.boxes = boxes;
        let rt = self.host.r.transpose();
        for op in &self.boxes {
            resource::check_current()?;
            if signed_permutation_map(&(rt * op.r), 1.0e-3).is_none() {
                return Ok(None);
            }
        }
        resource::check_current()?;
        Ok(Some(()))
    }
    fn reconcile(
        &self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> crate::Result<Option<()>> {
        resource::check_current()?;
        if self.boxes.is_empty() {
            return Ok(None);
        }
        let Some(opening) = self.current.as_ref() else { return Ok(None) };
        let meshes = super::source_option(router.get_opening_item_meshes_world(opening, decoder))?;
        let Some(meshes) = meshes else { return Ok(None) };
        let mesh_vol: f64 = meshes.iter().map(|m| mesh_signed_volume(m).abs()).sum();
        resource::check_current()?;
        if mesh_vol < 1.0e-9 {
            return Ok(None);
        }
        let box_vol: f64 = self
            .boxes
            .iter()
            .map(|b| 8.0 * b.half[0] * b.half[1] * b.half[2])
            .sum();
        let ratio = box_vol / mesh_vol;
        resource::check_current()?;
        Ok((0.97..1.03).contains(&ratio).then_some(()))
    }
}
