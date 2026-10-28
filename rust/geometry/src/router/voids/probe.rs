// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC parametric decode + cutter-mesh extraction from opening elements.

use super::{GeometryRouter, RectParam};
use crate::placement::Axis2Placement;
use crate::profile::Profile2D;
use crate::profiles::ProfileProcessor;
use crate::{Error, Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

/// A host or opening solid recovered as a single IfcExtrudedAreaSolid swept along
/// its profile normal (local ±Z), for the 2D opening-subtraction fast path
/// ([`super::bool2d_path`]). `m` maps profile-local coordinates (profile in the
/// z=0 plane, swept to `dir_sign·depth`) to NATIVE world (pre unit-scale / RTC),
/// composed as `placement · mapped-chain · solid-Position`.
pub(crate) struct ExtrudedSolidInfo {
    /// Full 2D profile (outer + any holes) in the solid's profile plane.
    pub profile: Profile2D,
    /// Extrusion depth (> 0).
    pub depth: f64,
    /// +1 for a +Z sweep, -1 for a -Z sweep (the only two eligible cases).
    pub dir_sign: f64,
    /// Profile-local → native-world transform.
    pub m: Matrix4<f64>,
}

mod rectangular;
use crate::representation::unwrap::{checked_probe, probe_result, unwrap_solid, Policy as UnwrapPolicy};

impl GeometryRouter {
    /// Extract extrusion direction and position transform from IfcExtrudedAreaSolid
    /// Returns (local_direction, position_transform)
    fn extract_extrusion_direction_from_solid(
        &self,
        solid: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<(Vector3<f64>, Option<Matrix4<f64>>)>> {
        checked_probe(|terminal| {
            // Get ExtrudedDirection (attribute 2: IfcDirection)
            let direction_attr = solid.get(2)?;
            let direction_entity = probe_result!(terminal, decoder.resolve_ref(direction_attr))??;
            probe_result!(terminal, crate::resource::check_current())?;
            let local_dir = EntityDecoder::direction3_of(&direction_entity).map(Vector3::from)?;

            // Get Position transform (attribute 1: IfcAxis2Placement3D)
            let position_transform = match solid.get(1) {
                Some(pos_attr) if !pos_attr.is_null() => {
                    match probe_result!(terminal, decoder.resolve_ref(pos_attr)) {
                        Some(Some(pos_entity)) if pos_entity.ifc_type == IfcType::IfcAxis2Placement3D => {
                            probe_result!(terminal, Axis2Placement::read_3d(&pos_entity, decoder).map(|frame| frame.matrix()))
                        }
                        _ => None,
                    }
                }
                _ => None,
            };

            Some((local_dir, position_transform))
        })
    }

    /// Recursively extract extrusion direction and position transform from representation item
    /// Handles IfcExtrudedAreaSolid, IfcBooleanClippingResult, and IfcMappedItem
    /// Returns (local_direction, position_transform) where direction is in local space.
    /// A miss is `Ok(None)`; a reached source/resource stop is returned typed.
    pub(crate) fn extract_extrusion_direction_recursive(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<(Vector3<f64>, Option<Matrix4<f64>>)>> {
        checked_probe(|terminal| {
            let (solid, mapping_chain) = probe_result!(terminal,
                unwrap_solid(item.clone(), None, UnwrapPolicy::FIRST, decoder,
                    |level, decoder| self.mapped_item_transform(&level.item, &level.map, decoder)))??;
            let (dir, position_transform) = probe_result!(terminal,
                self.extract_extrusion_direction_from_solid(&solid, decoder))??;
            let combined = match (mapping_chain.as_ref(), position_transform) {
                (Some(chain), Some(pos)) => Some(chain * pos),
                (Some(chain), None) => Some(*chain),
                (None, Some(pos)) => Some(pos),
                (None, None) => None,
            };
            Some((dir, combined))
        })
    }

    /// Items of the element's body shape representation(s), selected EXACTLY as
    /// the main mesh path (`process_element` /
    /// `process_element_with_submeshes_impl`): the effective representation type
    /// (`RepresentationType`, falling back to the `RepresentationIdentifier`
    /// when blank — CATIA #1661) filtered by [`crate::router::is_body_representation`], with a
    /// `MappedRepresentation` skipped when the element also carries direct body
    /// geometry (the mesh path's de-dup, so the fast path reads the same solids
    /// the renderer draws). Items from EVERY qualifying representation are
    /// collected — the mesh path merges them all — so a probe that requires a
    /// single item correctly DEFERS when the rendered body spans more than one
    /// representation instead of silently cutting only the first. The old raw
    /// `RepresentationType`-only match could latch onto an earlier auxiliary
    /// `SweptSolid`/`SolidModel` (or miss a CATIA blank-type/`Body`-identifier
    /// rep the renderer meshes), driving the cut off a DIFFERENT solid than the
    /// one rendered.
    fn body_representation_items(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Vec<DecodedEntity>> {
        let shape = crate::representation::product_shape(element, decoder).ok()??;
        let mut items = Vec::new();
        // The box/re-extrusion probe only accepts body geometry. Meshed also
        // handles typeless/annotation/structural representations, so retain
        // this narrower filter while sharing its mapped-duplicate exclusion.
        for rep in shape.select(element, crate::representation::Select::Meshed) {
            if rep.ifc_type != IfcType::IfcShapeRepresentation
                || !crate::router::effective_element_rep_type(element, rep)
                    .is_some_and(crate::router::is_body_representation)
            {
                continue;
            }
            if let Ok(rep_items) = crate::representation::rep_items(rep, decoder) {
                items.extend(rep_items);
            }
        }
        if items.is_empty() {
            None
        } else {
            Some(items)
        }
    }

    /// EXACT boxes for a body that is a UNION OF RECTANGULAR PRISMS (the common Tekla
    /// multi-solid opening): one box per representation item, or `None` if any item is not a
    /// rectangular extrusion. The cellular `rect_fast` cut subtracts the N boxes natively.
    pub fn parametric_rect_probe_all(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Vec<RectParam>> {
        let placement = self
            .get_placement_transform_from_element(element, decoder)
            .ok()?;
        let items = self.body_representation_items(element, decoder)?;
        if items.is_empty() {
            return None;
        }
        let mut boxes = Vec::with_capacity(items.len());
        for item in items {
            boxes.push(self.rect_param_from_item(item, &placement, decoder)?);
        }
        Some(boxes)
    }

    /// PHASE-0 CENSUS (read-only): the EXACT oriented rectangular box of an extruded
    /// element, read from the IFC parametrics (IfcRectangleProfileDef XDim/YDim/Depth +
    /// composed placement axes), NOT inferred from the f32 mesh. Returns `None` unless the
    /// element's body is a single clean IfcRectangleProfileDef extrusion (after unwrapping
    /// IfcBooleanClippingResult / IfcMappedItem). This is the parametric frame + extents the
    /// failed oriented attempt should have used instead of `infer_opening_frame` + mesh-AABB.
    pub fn parametric_rect_probe(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<RectParam> {
        let placement = self
            .get_placement_transform_from_element(element, decoder)
            .ok()?;
        // A clean rectangular extrusion is exactly ONE Body item. A multi-solid
        // body (the probe would otherwise read only the first) must defer so the
        // exact kernel cuts all of it. Sharing `body_representation_items` +
        // `rect_param_from_item` with `parametric_rect_probe_all` keeps the host
        // frame and the cutter frames on ONE derivation - they cannot drift into
        // a silent miscut (they feed the same shared-frame cellular cut).
        let items = self.body_representation_items(element, decoder)?;
        if items.len() != 1 {
            return None;
        }
        self.rect_param_from_item(items.into_iter().next()?, &placement, decoder)
    }

    /// Get per-item meshes for an opening element, transformed to world coordinates.
    /// Uses the same `transform_mesh` path as `process_element` to ensure identical
    /// coordinate handling (ObjectPlacement, unit scaling, conditional RTC offset).
    pub fn get_opening_item_meshes_world(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        crate::program::openings::item_meshes(element, self, decoder)
    }

    /// Extrusion direction is in world coordinates, normalized
    /// Returns None for extrusion direction if it cannot be extracted (fallback to bounds-only)
    pub fn get_opening_item_bounds_with_direction(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)>> {
        crate::program::openings::item_bounds(element, self, decoder)
    }

    /// Source admission of one opening probe: the items of the representations
    /// the mesh path meshes (body only, and a MappedRepresentation skipped when
    /// direct body geometry duplicates it, so one void yields one cutter, not
    /// two: ROUTER-28, #7690), plus the unit-scaled element placement. A null
    /// representation admits no items. Items are meshed by the caller's
    /// canonical item children, never here.
    pub(crate) fn opening_probe_source(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Vec<DecodedEntity>, Matrix4<f64>)> {
        use crate::representation::{product_shape_unchecked, rep_items, Select, ShapeError};
        // Preserve unchecked shape type and established error text (#7781).
        let shape = product_shape_unchecked(element, decoder).map_err(|error| match error {
            ShapeError::NoRepresentationAttribute { .. } => {
                Error::geometry("Element has no representation attribute".to_string())
            }
            ShapeError::MissingRepresentations => {
                Error::geometry("ProductDefinitionShape missing Representations".to_string())
            }
            other => Error::from(other),
        })?;
        let Some(shape) = shape else {
            return Ok((Vec::new(), Matrix4::identity()));
        };

        // The same placement transform that apply_placement uses. An ordinary
        // placement fault keeps identity; a typed stop is never swallowed.
        let mut placement = match crate::resource::observe(
            self.get_placement_transform_from_element(element, decoder),
        ) {
            Err(stop @ Error::ProgramStopped(_)) => return Err(stop),
            result => result.unwrap_or_else(|_| Matrix4::identity()),
        };
        self.scale_transform(&mut placement);

        let mut items = Vec::new();
        for shape_rep in shape.select(element, Select::Meshed) {
            if shape_rep.get(3).is_none() {
                continue;
            }
            match crate::resource::observe(rep_items(shape_rep, decoder).map_err(Error::from)) {
                Ok(rep_items) if items.is_empty() => items = rep_items,
                Ok(rep_items) => items.extend(rep_items),
                Err(stop @ Error::ProgramStopped(_)) => return Err(stop),
                Err(_) => continue,
            }
        }
        Ok((items, placement))
    }

    /// Unwrap `item` — through `IfcMappedItem` (accumulating the mapping
    /// transform), but NOT through `IfcBooleanClippingResult`/`IfcBooleanResult`
    /// (a clipped host is ineligible for the 2D re-extrude) — to a single
    /// `IfcExtrudedAreaSolid` swept along its profile normal (local ±Z), and
    /// recover its full 2D profile + depth + composed profile-local→native-world
    /// transform. Returns `None` for any non-extrusion, clipped, obliquely-swept,
    /// or degenerate solid, so callers fall back to the exact kernel.
    pub(super) fn extruded_solid_from_item(
        &self,
        item: DecodedEntity,
        placement: &Matrix4<f64>,
        decoder: &mut EntityDecoder,
    ) -> Option<ExtrudedSolidInfo> {
        let (solid, chain) = unwrap_solid(
            item,
            Some(Matrix4::identity()),
            UnwrapPolicy::SINGLE_UNCLIPPED,
            decoder,
            |level, decoder| self.mapped_item_transform(&level.item, &level.map, decoder),
        )
        .ok()??;
        let chain = chain?;

        let profile_entity = decoder.resolve_ref(solid.get(0)?).ok()??;
        // The 2D path re-extrudes ONE outer ring with holes; a composite of
        // several disjoint areas (#7685) defers to the 3D path.
        let [profile] = <[_; 1]>::try_from(
            ProfileProcessor::new(self.schema.clone())
                .process_regions(&profile_entity, decoder, self.tessellation_quality)
                .ok()?,
        )
        .ok()?;
        if profile.outer.len() < 3 {
            return None;
        }
        let depth = solid.get_float(3)?;
        if !depth.is_finite() || depth <= 0.0 {
            return None;
        }
        let dir_local = {
            let e = decoder.resolve_ref(solid.get(2)?).ok()??;
            EntityDecoder::direction3_of(&e).map(Vector3::from)?
        }
        .try_normalize(1e-12)?;
        // The 2D re-extrude is only valid when the sweep is along the profile
        // normal (local ±Z). An oblique / sheared extrusion shifts the footprint
        // with depth, so the through-cut projection would be wrong — defer.
        if dir_local.x.abs() > 1e-6 || dir_local.y.abs() > 1e-6 {
            return None;
        }
        let dir_sign = if dir_local.z >= 0.0 { 1.0 } else { -1.0 };
        let solid_pos = match solid.get(1) {
            Some(a) if !a.is_null() => {
                let e = decoder.resolve_ref(a).ok()??;
                Axis2Placement::read_3d(&e, decoder).ok()?.matrix()
            }
            _ => Matrix4::identity(),
        };
        Some(ExtrudedSolidInfo {
            profile,
            depth,
            dir_sign,
            m: placement * chain * solid_pos,
        })
    }

    /// The host element's body as a SINGLE eligible extruded solid (exactly one
    /// Body item, an `IfcExtrudedAreaSolid` after unwrapping mapped items). A
    /// multi-item body or a clipped host returns `None`.
    pub(crate) fn host_extruded_solid(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<ExtrudedSolidInfo> {
        let placement = self
            .get_placement_transform_from_element(element, decoder)
            .ok()?;
        let items = self.body_representation_items(element, decoder)?;
        if items.len() != 1 {
            return None;
        }
        self.extruded_solid_from_item(items.into_iter().next()?, &placement, decoder)
    }

    /// Every Body item of an opening element as an eligible extruded solid (an
    /// opening may be a union of extruded prisms — Tekla multi-solid). `None` if
    /// the body is empty or ANY item is not a clean extruded solid.
    pub(crate) fn opening_extruded_solids(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Vec<ExtrudedSolidInfo>> {
        let placement = self
            .get_placement_transform_from_element(element, decoder)
            .ok()?;
        let items = self.body_representation_items(element, decoder)?;
        if items.is_empty() {
            return None;
        }
        let mut out = Vec::with_capacity(items.len());
        for it in items {
            out.push(self.extruded_solid_from_item(it, &placement, decoder)?);
        }
        Some(out)
    }
}

#[cfg(test)]
#[path = "probe/unwrap_tests.rs"]
mod unwrap_tests;

#[cfg(test)]
#[path = "probe/source_tests.rs"]
mod source_tests;
