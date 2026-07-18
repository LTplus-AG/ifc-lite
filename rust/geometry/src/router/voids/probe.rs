// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC parametric decode + cutter-mesh extraction from opening elements.

use super::geom::*;
use super::{GeometryRouter, RectParam, MAX_EXTRUSION_EXTRACT_DEPTH};
use crate::profile::Profile2D;
use crate::profiles::ProfileProcessor;
use crate::router::is_body_representation;
use crate::{Error, Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Matrix3, Matrix4};
use rustc_hash::FxHashSet;

/// A host or opening solid recovered as a single IfcExtrudedAreaSolid swept along
/// its profile normal (local ±Z), for the 2D opening-subtraction fast path
/// ([`super::bool2d_path`]). `m` maps profile-local coordinates (profile in the
/// z=0 plane, swept to `dir_sign·depth`) to NATIVE world (pre unit-scale / RTC),
/// composed as `placement · mapped-chain · solid-Position`.
pub(super) struct ExtrudedSolidInfo {
    /// Full 2D profile (outer + any holes) in the solid's profile plane.
    pub profile: Profile2D,
    /// Extrusion depth (> 0).
    pub depth: f64,
    /// +1 for a +Z sweep, -1 for a -Z sweep (the only two eligible cases).
    pub dir_sign: f64,
    /// Profile-local → native-world transform.
    pub m: Matrix4<f64>,
}

impl GeometryRouter {
    // Get individual bounding boxes for each representation item in an opening element.
    // This handles disconnected geometry (e.g., two separate window openings in one IfcOpeningElement)
    // by returning separate bounds for each item instead of one combined bounding box.

    /// Extract extrusion direction and position transform from IfcExtrudedAreaSolid
    /// Returns (local_direction, position_transform)
    fn extract_extrusion_direction_from_solid(
        &self,
        solid: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(Vector3<f64>, Option<Matrix4<f64>>)> {
        // Get ExtrudedDirection (attribute 2: IfcDirection)
        let direction_attr = solid.get(2)?;
        let direction_entity = decoder.resolve_ref(direction_attr).ok()??;
        let local_dir = self.parse_direction(&direction_entity).ok()?;

        // Get Position transform (attribute 1: IfcAxis2Placement3D)
        let position_transform = if let Some(pos_attr) = solid.get(1) {
            if !pos_attr.is_null() {
                if let Ok(Some(pos_entity)) = decoder.resolve_ref(pos_attr) {
                    if pos_entity.ifc_type == IfcType::IfcAxis2Placement3D {
                        self.parse_axis2_placement_3d(&pos_entity, decoder).ok()
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        Some((local_dir, position_transform))
    }

    /// Recursively extract extrusion direction and position transform from representation item
    /// Handles IfcExtrudedAreaSolid, IfcBooleanClippingResult, and IfcMappedItem
    /// Returns (local_direction, position_transform) where direction is in local space
    fn extract_extrusion_direction_recursive(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(Vector3<f64>, Option<Matrix4<f64>>)> {
        let mut current = item.clone();
        let mut visited = FxHashSet::default();
        let mut mapping_chain: Option<Matrix4<f64>> = None;

        for _depth in 0..MAX_EXTRUSION_EXTRACT_DEPTH {
            if !visited.insert(current.id) {
                return None;
            }

            match current.ifc_type {
                IfcType::IfcExtrudedAreaSolid => {
                    let (dir, position_transform) =
                        self.extract_extrusion_direction_from_solid(&current, decoder)?;
                    let combined = match (mapping_chain.as_ref(), position_transform) {
                        (Some(chain), Some(pos)) => Some(chain * pos),
                        (Some(chain), None) => Some(*chain),
                        (None, Some(pos)) => Some(pos),
                        (None, None) => None,
                    };
                    return Some((dir, combined));
                }
                IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult => {
                    // FirstOperand (attribute 1) contains base geometry
                    let first_attr = current.get(1)?;
                    current = decoder.resolve_ref(first_attr).ok()??;
                }
                IfcType::IfcMappedItem => {
                    // MappingSource (attribute 0) -> MappedRepresentation -> Items
                    let source_attr = current.get(0)?;
                    let source = decoder.resolve_ref(source_attr).ok()??;
                    // RepresentationMap.MappedRepresentation is attribute 1
                    let rep_attr = source.get(1)?;
                    let rep = decoder.resolve_ref(rep_attr).ok()??;

                    // MappingTarget (attribute 1) -> instance transform
                    if let Some(target_attr) = current.get(1) {
                        if !target_attr.is_null() {
                            if let Ok(Some(target)) = decoder.resolve_ref(target_attr) {
                                if let Ok(map) =
                                    self.parse_cartesian_transformation_operator(&target, decoder)
                                {
                                    mapping_chain = Some(match mapping_chain.take() {
                                        Some(chain) => chain * map,
                                        None => map,
                                    });
                                }
                            }
                        }
                    }

                    // Get first item from representation
                    let items_attr = rep.get(3)?;
                    let items = decoder.resolve_ref_list(items_attr).ok()?;
                    current = items.first()?.clone();
                }
                _ => return None,
            }
        }

        None
    }

    /// Read a rectangular swept area as `(x_dim, y_dim, off_x, off_y, cos, sin)` in the
    /// profile plane. Handles `IfcRectangleProfileDef` (XDim/YDim + 2D Position rotation)
    /// AND an `IfcArbitraryClosedProfileDef` whose outer curve is an axis-aligned 4-point
    /// rectangle polyline (the common Tekla/structural authoring of a rectangular wall).
    /// `None` for any non-rectangular profile → the caller defers to the exact kernel.
    fn read_rect_profile_2d(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64, f64, f64, f64)> {
        match profile.ifc_type {
            IfcType::IfcRectangleProfileDef => {
                let x_dim = profile.get_float(3)?;
                let y_dim = profile.get_float(4)?;
                // Position (attr 2 = IfcAxis2Placement2D): in-plane rotation + offset.
                let (mut cos_t, mut sin_t, mut off_x, mut off_y) = (1.0, 0.0, 0.0, 0.0);
                if let Some(pos_attr) = profile.get(2) {
                    if !pos_attr.is_null() {
                        if let Ok(Some(pos)) = decoder.resolve_ref(pos_attr) {
                            if let Some(loc_attr) = pos.get(0) {
                                if let Ok(Some(loc)) = decoder.resolve_ref(loc_attr) {
                                    if let Some(c) = loc.get(0).and_then(|x| x.as_list()) {
                                        off_x = c.first().and_then(|x| x.as_float()).unwrap_or(0.0);
                                        off_y = c.get(1).and_then(|x| x.as_float()).unwrap_or(0.0);
                                    }
                                }
                            }
                            if let Some(rd_attr) = pos.get(1) {
                                if !rd_attr.is_null() {
                                    if let Ok(Some(rd)) = decoder.resolve_ref(rd_attr) {
                                        if let Some(c) = rd.get(0).and_then(|x| x.as_list()) {
                                            let dx =
                                                c.first().and_then(|x| x.as_float()).unwrap_or(1.0);
                                            let dy =
                                                c.get(1).and_then(|x| x.as_float()).unwrap_or(0.0);
                                            let n = (dx * dx + dy * dy).sqrt();
                                            if n > 1e-12 {
                                                cos_t = dx / n;
                                                sin_t = dy / n;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Some((x_dim, y_dim, off_x, off_y, cos_t, sin_t))
            }
            IfcType::IfcArbitraryClosedProfileDef => {
                // OuterCurve (attr 2) must be an axis-aligned rectangle polyline.
                let curve = decoder.resolve_ref(profile.get(2)?).ok()??;
                if curve.ifc_type != IfcType::IfcPolyline {
                    return None;
                }
                let pts = decoder.resolve_ref_list(curve.get(0)?).ok()?;
                let mut coords: Vec<(f64, f64)> = Vec::with_capacity(pts.len());
                for p in &pts {
                    let c = p.get(0).and_then(|x| x.as_list())?;
                    coords.push((c.first()?.as_float()?, c.get(1)?.as_float()?));
                }
                // Drop a repeated closing vertex.
                if coords.len() >= 2 {
                    let (f, l) = (coords[0], coords[coords.len() - 1]);
                    if (f.0 - l.0).abs() < 1e-9 && (f.1 - l.1).abs() < 1e-9 {
                        coords.pop();
                    }
                }
                if coords.len() != 4 {
                    return None;
                }
                // General 4-point RECTANGLE — axis-aligned OR rotated in-plane. Compute the
                // oriented box from its edges and fold the in-plane rotation into the frame
                // (`cos_t`/`sin_t`). Tekla / IFC2X3 routinely author rotated-rectangle
                // openings this way, so the old axis-aligned-only check rejected ~90% of
                // them. Axis-aligned is just the cos_t=1, sin_t=0 special case.
                let p = &coords;
                let edge = |i: usize| (p[(i + 1) % 4].0 - p[i].0, p[(i + 1) % 4].1 - p[i].1);
                let len = |e: (f64, f64)| (e.0 * e.0 + e.1 * e.1).sqrt();
                let e0 = edge(0);
                let e1 = edge(1);
                let e2 = edge(2);
                let (xd, yd) = (len(e0), len(e1));
                if xd <= 1e-9 || yd <= 1e-9 {
                    return None;
                }
                // Rectangle: adjacent edges perpendicular AND opposite edges equal length.
                let dot = (e0.0 * e1.0 + e0.1 * e1.1) / (xd * yd);
                if dot.abs() > 0.01 || (len(e2) - xd).abs() > xd * 0.01 + 1e-6 {
                    return None;
                }
                // Local X' = first-edge direction; centre = polygon centroid.
                let (cos_t, sin_t) = (e0.0 / xd, e0.1 / xd);
                let cx = (p[0].0 + p[1].0 + p[2].0 + p[3].0) * 0.25;
                let cy = (p[0].1 + p[1].1 + p[2].1 + p[3].1) * 0.25;
                Some((xd, yd, cx, cy, cos_t, sin_t))
            }
            _ => None,
        }
    }

    /// Items of the element's body shape representation(s), selected EXACTLY as
    /// the main mesh path (`process_element` /
    /// `process_element_with_submeshes_impl`): the effective representation type
    /// (`RepresentationType`, falling back to the `RepresentationIdentifier`
    /// when blank — CATIA #1661) filtered by [`is_body_representation`], with a
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
        let rep = decoder.resolve_ref(element.get(6)?).ok()??;
        if rep.ifc_type != IfcType::IfcProductDefinitionShape {
            return None;
        }
        let reps = decoder.resolve_ref_list(rep.get(2)?).ok()?;
        // Mirror the mesh path's direct-vs-mapped de-dup: a MappedRepresentation
        // is skipped only when the element ALSO carries direct body geometry.
        let has_direct_geometry = reps.iter().any(|sr| {
            sr.ifc_type == IfcType::IfcShapeRepresentation
                && crate::router::effective_rep_type(sr)
                    .map(crate::router::is_direct_body_representation)
                    .unwrap_or(false)
        });
        let mut items = Vec::new();
        for sr in reps {
            if sr.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }
            let Some(rt) = crate::router::effective_rep_type(&sr) else {
                continue;
            };
            if rt == "MappedRepresentation" && has_direct_geometry {
                continue;
            }
            if !crate::router::is_body_representation(rt) {
                continue;
            }
            let Some(items_attr) = sr.get(3) else {
                continue;
            };
            if let Ok(rep_items) = decoder.resolve_ref_list(items_attr) {
                items.extend(rep_items);
            }
        }
        if items.is_empty() {
            None
        } else {
            Some(items)
        }
    }

    /// Whether an `IfcMappedItem`'s `RepresentationMap.MappingOrigin` (attr 0) is
    /// a geometric no-op for the fast-path solid recovery.
    ///
    /// The `IfcMappedItem` MESH path drops `MappingOrigin` entirely and applies
    /// ONLY the `MappingTarget` operator (see
    /// [`GeometryRouter::process_mapped_item_cached`] and
    /// `profile_extractor::extract_mapped_item_profiles`, whose composed
    /// transform is `elem_transform · mapping_target`). To stay bit-for-bit
    /// consistent with that rendered geometry — the very geometry the exact void
    /// kernel also cuts — this fast path must drop it too. A non-identity origin
    /// would shift the recovered solid off the rendered mesh, so we only proceed
    /// when the origin provably has no effect; otherwise the caller defers the
    /// whole opening/host to the exact kernel. Returns `true` when the origin is
    /// absent / null / an identity `IfcAxis2Placement3D`, `false` when it is
    /// non-identity, a 2D placement, or cannot be confirmed identity.
    fn mapping_origin_is_identity(
        &self,
        source: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> bool {
        let Some(origin_attr) = source.get(0) else {
            return true; // no MappingOrigin attribute -> no effect
        };
        if origin_attr.is_null() {
            return true;
        }
        let origin = match decoder.resolve_ref(origin_attr) {
            Ok(Some(e)) => e,
            _ => return false, // present but unresolvable -> defer
        };
        // Only a 3D identity placement is a provable no-op for the 3D solid
        // recovery; a 2D placement (or anything else) -> defer.
        if origin.ifc_type != IfcType::IfcAxis2Placement3D {
            return false;
        }
        match self.parse_axis2_placement_3d(&origin, decoder) {
            Ok(m) => {
                let id = Matrix4::<f64>::identity();
                m.iter().zip(id.iter()).all(|(a, b)| (a - b).abs() < 1e-9)
            }
            Err(_) => false,
        }
    }

    /// One representation item → its EXACT oriented box, unwrapping IfcBooleanClippingResult
    /// / IfcMappedItem to the IfcExtrudedAreaSolid. `None` unless it is a rectangular prism.
    /// Frame + extents from the parametrics (× unit_scale, − rtc_offset to match the mesh).
    fn rect_param_from_item(
        &self,
        item: DecodedEntity,
        placement: &Matrix4<f64>,
        decoder: &mut EntityDecoder,
    ) -> Option<RectParam> {
        let mut current = item;
        let mut chain = Matrix4::<f64>::identity();
        let mut visited = FxHashSet::default();
        let solid = loop {
            if !visited.insert(current.id) || visited.len() > MAX_EXTRUSION_EXTRACT_DEPTH {
                return None;
            }
            match current.ifc_type {
                IfcType::IfcExtrudedAreaSolid => break current,
                IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult => {
                    current = decoder.resolve_ref(current.get(1)?).ok()??;
                }
                IfcType::IfcMappedItem => {
                    let source = decoder.resolve_ref(current.get(0)?).ok()??;
                    let mapped_rep = decoder.resolve_ref(source.get(1)?).ok()??;
                    // The mesh path drops MappingOrigin (applies only
                    // MappingTarget); a non-identity origin would shift the
                    // recovered box off the rendered solid, so defer.
                    if !self.mapping_origin_is_identity(&source, decoder) {
                        return None;
                    }
                    if let Some(t) = current.get(1) {
                        if !t.is_null() {
                            if let Ok(Some(te)) = decoder.resolve_ref(t) {
                                if let Ok(m) =
                                    self.parse_cartesian_transformation_operator(&te, decoder)
                                {
                                    chain *= m;
                                }
                            }
                        }
                    }
                    current =
                        decoder.resolve_ref_list(mapped_rep.get(3)?).ok()?.into_iter().next()?;
                }
                _ => return None,
            }
        };

        let profile = decoder.resolve_ref(solid.get(0)?).ok()??;
        let (x_dim, y_dim, off_x, off_y, cos_t, sin_t) =
            self.read_rect_profile_2d(&profile, decoder)?;
        let depth = solid.get_float(3)?;
        if !(x_dim.is_finite()
            && y_dim.is_finite()
            && depth.is_finite()
            && x_dim > 0.0
            && y_dim > 0.0
            && depth > 0.0)
        {
            return None;
        }
        let solid_pos = match solid.get(1) {
            Some(a) if !a.is_null() => {
                let e = decoder.resolve_ref(a).ok()??;
                self.parse_axis2_placement_3d(&e, decoder).ok()?
            }
            _ => Matrix4::identity(),
        };
        let dir_local = {
            let e = decoder.resolve_ref(solid.get(2)?).ok()??;
            self.parse_direction(&e).ok()?
        };

        let u = Vector3::new(cos_t, sin_t, 0.0);
        let v = Vector3::new(-sin_t, cos_t, 0.0);
        let w = dir_local.try_normalize(1e-12)?;
        let m = placement * chain * solid_pos;
        let rot = m.fixed_view::<3, 3>(0, 0).into_owned();
        let uu = (rot * u).try_normalize(1e-9)?;
        let vv = (rot * v).try_normalize(1e-9)?;
        let ww = (rot * w).try_normalize(1e-9)?;
        let center_local = Point3::new(off_x, off_y, 0.0) + w * (depth * 0.5);
        let center_native = m.transform_point(&center_local);
        let s = self.unit_scale;
        let (rx, ry, rz) = self.rtc_offset;
        Some(RectParam {
            r: Matrix3::from_columns(&[uu, vv, ww]),
            center: Point3::new(
                center_native.x * s - rx,
                center_native.y * s - ry,
                center_native.z * s - rz,
            ),
            half: [x_dim * 0.5 * s, y_dim * 0.5 * s, depth * 0.5 * s],
        })
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
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry("Element has no representation attribute".to_string())
        })?;
        if representation_attr.is_null() {
            return Ok(vec![]);
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("ProductDefinitionShape missing Representations".to_string())
        })?;
        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Get the same placement transform that apply_placement uses
        let mut placement_transform = self
            .get_placement_transform_from_element(element, decoder)
            .unwrap_or_else(|_| Matrix4::identity());
        self.scale_transform(&mut placement_transform);

        let mut item_meshes = Vec::new();

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }
            if let Some(rep_type) = crate::router::effective_rep_type(&shape_rep) {
                if !is_body_representation(rep_type) {
                    continue;
                }
            }
            let items_attr = match shape_rep.get(3) {
                Some(attr) => attr,
                None => continue,
            };
            let items = match decoder.resolve_ref_list(items_attr) {
                Ok(items) => items,
                Err(_) => continue,
            };

            for item in items {
                let mut mesh = match self.process_representation_item(&item, decoder) {
                    Ok(m) if !m.is_empty() => m,
                    _ => continue,
                };

                // Keep the host in absolute world/RTC coordinates here: the void cut
                // (`apply_void_context`) matches it against world-coordinate opening
                // cutters, so relativizing the host now would silently break every
                // cut. The per-element local-origin relativization is applied to the
                // CSG OUTPUT instead (shared host+cutter frame).
                self.transform_mesh_world_framed(&mut mesh, &placement_transform, false);

                item_meshes.push(mesh);
            }
        }

        Ok(item_meshes)
    }

    /// Extrusion direction is in world coordinates, normalized
    /// Returns None for extrusion direction if it cannot be extracted (fallback to bounds-only)
    pub fn get_opening_item_bounds_with_direction(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)>> {
        // Get representation (attribute 6 for most building elements)
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry("Element has no representation attribute".to_string())
        })?;

        if representation_attr.is_null() {
            return Ok(vec![]);
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;

        // Get representations list
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("ProductDefinitionShape missing Representations".to_string())
        })?;

        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Get placement transform
        let mut placement_transform = self
            .get_placement_transform_from_element(element, decoder)
            .unwrap_or_else(|_| Matrix4::identity());
        self.scale_transform(&mut placement_transform);

        let mut bounds_list = Vec::new();

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            // Check representation type
            if let Some(rep_type) = crate::router::effective_rep_type(&shape_rep) {
                if !is_body_representation(rep_type) {
                    continue;
                }
            }

            // Get items list
            let items_attr = match shape_rep.get(3) {
                Some(attr) => attr,
                None => continue,
            };

            let items = match decoder.resolve_ref_list(items_attr) {
                Ok(items) => items,
                Err(_) => continue,
            };

            // Process each item separately to get individual bounds
            for item in items {
                // Try to extract extrusion direction recursively (handles wrappers)
                let extrusion_direction = if let Some((local_dir, position_transform)) =
                    self.extract_extrusion_direction_recursive(&item, decoder)
                {
                    // A zero-length IFCDIRECTION drops only THIS item's direction
                    // (coarser bounds), not `?`-abort every sibling item's bounds.
                    let element_rot = extract_rotation_columns(&placement_transform);
                    if let Some(pos_transform) = position_transform {
                        let pos_rot = extract_rotation_columns(&pos_transform);
                        rotate_and_normalize(&pos_rot, &local_dir)
                            .ok()
                            .and_then(|world_dir| {
                                rotate_and_normalize(&element_rot, &world_dir).ok()
                            })
                    } else {
                        rotate_and_normalize(&element_rot, &local_dir).ok()
                    }
                } else {
                    None
                };

                // Get mesh bounds (same as original function)
                let mesh = match self.process_representation_item(&item, decoder) {
                    Ok(m) if !m.is_empty() => m,
                    _ => continue,
                };

                // Get bounds and transform to world coordinates
                let (mesh_min, mesh_max) = mesh.bounds();

                // Transform corner points to world coordinates
                let corners = [
                    Point3::new(mesh_min.x as f64, mesh_min.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_min.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_min.x as f64, mesh_max.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_max.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_min.x as f64, mesh_min.y as f64, mesh_max.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_min.y as f64, mesh_max.z as f64),
                    Point3::new(mesh_min.x as f64, mesh_max.y as f64, mesh_max.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_max.y as f64, mesh_max.z as f64),
                ];

                // Transform all corners and compute new AABB
                let transformed: Vec<Point3<f64>> = corners
                    .iter()
                    .map(|p| placement_transform.transform_point(p))
                    .collect();

                let world_min = Point3::new(
                    transformed
                        .iter()
                        .map(|p| p.x)
                        .fold(f64::INFINITY, f64::min),
                    transformed
                        .iter()
                        .map(|p| p.y)
                        .fold(f64::INFINITY, f64::min),
                    transformed
                        .iter()
                        .map(|p| p.z)
                        .fold(f64::INFINITY, f64::min),
                );
                let world_max = Point3::new(
                    transformed
                        .iter()
                        .map(|p| p.x)
                        .fold(f64::NEG_INFINITY, f64::max),
                    transformed
                        .iter()
                        .map(|p| p.y)
                        .fold(f64::NEG_INFINITY, f64::max),
                    transformed
                        .iter()
                        .map(|p| p.z)
                        .fold(f64::NEG_INFINITY, f64::max),
                );

                // Apply RTC offset to opening bounds so they match wall mesh coordinate system
                // Wall mesh positions have RTC subtracted during transform_mesh, so opening bounds must match
                let rtc = self.rtc_offset;
                let rtc_min = Point3::new(
                    world_min.x - rtc.0,
                    world_min.y - rtc.1,
                    world_min.z - rtc.2,
                );
                let rtc_max = Point3::new(
                    world_max.x - rtc.0,
                    world_max.y - rtc.1,
                    world_max.z - rtc.2,
                );

                bounds_list.push((rtc_min, rtc_max, extrusion_direction));
            }
        }

        Ok(bounds_list)
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
        let mut current = item;
        let mut chain = Matrix4::<f64>::identity();
        let mut visited = FxHashSet::default();
        let solid = loop {
            if !visited.insert(current.id) || visited.len() > MAX_EXTRUSION_EXTRACT_DEPTH {
                return None;
            }
            match current.ifc_type {
                IfcType::IfcExtrudedAreaSolid => break current,
                IfcType::IfcMappedItem => {
                    let source = decoder.resolve_ref(current.get(0)?).ok()??;
                    let mapped_rep = decoder.resolve_ref(source.get(1)?).ok()??;
                    // The mesh path drops MappingOrigin (applies only
                    // MappingTarget); a non-identity origin would shift the
                    // re-extruded footprint off the rendered solid, so defer the
                    // whole opening to the exact kernel.
                    if !self.mapping_origin_is_identity(&source, decoder) {
                        return None;
                    }
                    // A non-null MappingTarget MUST resolve + parse to a valid
                    // transform: silently dropping it would misplace the
                    // re-extruded footprint, so any failure defers the whole
                    // opening to the exact kernel rather than continuing with an
                    // identity transform.
                    if let Some(t) = current.get(1) {
                        if !t.is_null() {
                            let te = decoder.resolve_ref(t).ok()??;
                            let mm =
                                self.parse_cartesian_transformation_operator(&te, decoder).ok()?;
                            chain *= mm;
                        }
                    }
                    // Require EXACTLY ONE mapped representation item. A multi-item
                    // mapped opening would otherwise be reduced to its first
                    // solid, dropping the rest from BOTH the 2D footprint and the
                    // residual exact cut; defer the whole opening instead.
                    let mut items = decoder.resolve_ref_list(mapped_rep.get(3)?).ok()?.into_iter();
                    let first = items.next()?;
                    if items.next().is_some() {
                        return None;
                    }
                    current = first;
                }
                // Boolean clipping / anything else: ineligible for the 2D path.
                _ => return None,
            }
        };

        let profile_entity = decoder.resolve_ref(solid.get(0)?).ok()??;
        let profile = ProfileProcessor::new(self.schema.clone())
            .process(&profile_entity, decoder, self.tessellation_quality)
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
            self.parse_direction(&e).ok()?
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
                self.parse_axis2_placement_3d(&e, decoder).ok()?
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
    pub(super) fn host_extruded_solid(
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
    pub(super) fn opening_extruded_solids(
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
