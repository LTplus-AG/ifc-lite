// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 2D void subtraction: profile-level opening processing for extrusions.

use super::GeometryRouter;
use crate::bool2d::subtract_multiple_2d;
use crate::csg::ClippingProcessor;
use crate::profile::{Profile2D, Profile2DWithVoids, VoidInfo};
use crate::void_analysis::{extract_coplanar_voids, extract_nonplanar_voids, VoidAnalyzer};
use crate::void_index::VoidIndex;
use crate::{Error, Mesh, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Matrix4, Point2};
use rustc_hash::FxHashMap;

impl GeometryRouter {
    /// Process element with voids using 2D profile-level operations
    ///
    /// This is a smarter and more efficient approach that:
    /// 1. Classifies voids as coplanar (can subtract in 2D) or non-planar (need 3D CSG)
    /// 2. Subtracts coplanar voids at the 2D profile level before extrusion
    /// 3. Falls back to 3D CSG only for non-planar voids
    ///
    /// Benefits:
    /// - 10-25x faster than full 3D CSG for most openings
    /// - More reliable, especially for floors/slabs with many penetrations
    /// - Cleaner geometry with fewer degenerate triangles
    #[inline]
    pub fn process_element_with_voids_2d(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        void_index: &VoidIndex,
    ) -> Result<Mesh> {
        // Check if this element has any openings
        let opening_ids = void_index.get_voids(element.id);

        if opening_ids.is_empty() {
            // No openings, just process normally
            return self.process_element(element, decoder);
        }

        // Try to extract extrusion parameters for 2D void processing
        // If the element isn't an extrusion, fall back to 3D CSG
        match self.try_process_extrusion_with_voids_2d(element, decoder, opening_ids) {
            Ok(Some(mesh)) => Ok(mesh),
            Ok(None) | Err(_) => {
                // Fall back to traditional 3D CSG approach
                let void_map: FxHashMap<u32, Vec<u32>> =
                    [(element.id, opening_ids.to_vec())].into_iter().collect();
                self.process_element_with_voids(element, decoder, &void_map)
            }
        }
    }

    /// Try to process an extrusion with 2D void subtraction
    ///
    /// Returns Ok(Some(mesh)) if 2D processing was successful,
    /// Ok(None) if the element is not suitable for 2D processing,
    /// Err if an error occurred.
    fn try_process_extrusion_with_voids_2d(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        opening_ids: &[u32],
    ) -> Result<Option<Mesh>> {
        // Get representation
        let representation_attr = match element.get(6) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok(None),
        };

        let representation = match decoder.resolve_ref(representation_attr)? {
            Some(r) => r,
            None => return Ok(None),
        };

        if representation.ifc_type != IfcType::IfcProductDefinitionShape {
            return Ok(None);
        }

        // Find an IfcExtrudedAreaSolid in the representations
        let representations_attr = match representation.get(2) {
            Some(attr) => attr,
            None => return Ok(None),
        };

        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Look for extruded area solid
        for shape_rep in &representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            let items_attr = match shape_rep.get(3) {
                Some(attr) => attr,
                None => continue,
            };

            let items = decoder.resolve_ref_list(items_attr)?;

            for item in &items {
                if item.ifc_type == IfcType::IfcExtrudedAreaSolid {
                    // Found an extrusion - try 2D void processing
                    return self.process_extrusion_with_voids_2d_impl(
                        element,
                        item,
                        decoder,
                        opening_ids,
                    );
                }
            }
        }

        Ok(None)
    }

    /// Implementation of 2D void processing for extrusions
    fn process_extrusion_with_voids_2d_impl(
        &self,
        element: &DecodedEntity,
        extrusion: &DecodedEntity,
        decoder: &mut EntityDecoder,
        opening_ids: &[u32],
    ) -> Result<Option<Mesh>> {
        // Extract extrusion parameters
        // IfcExtrudedAreaSolid: SweptArea, Position, ExtrudedDirection, Depth

        // Get depth (attribute 3)
        let depth = match extrusion.get_float(3) {
            Some(d) if d > 0.0 => d,
            _ => return Ok(None),
        };

        // Get extrusion direction (attribute 2)
        let direction_attr = match extrusion.get(2) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok(None),
        };

        let direction_entity = match decoder.resolve_ref(direction_attr)? {
            Some(e) => e,
            None => return Ok(None),
        };

        let local_extrusion_direction = self.parse_direction(&direction_entity)?;

        // Get position transform (attribute 1)
        let position_transform = if let Some(pos_attr) = extrusion.get(1) {
            if !pos_attr.is_null() {
                if let Some(pos_entity) = decoder.resolve_ref(pos_attr)? {
                    self.parse_axis2_placement_3d(&pos_entity, decoder)?
                } else {
                    Matrix4::identity()
                }
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        };

        // Transform extrusion direction from local to world coordinates
        // ExtrudedDirection is specified in Position's local coordinate system
        let extrusion_direction = {
            let rot_x = Vector3::new(
                position_transform[(0, 0)],
                position_transform[(1, 0)],
                position_transform[(2, 0)],
            );
            let rot_y = Vector3::new(
                position_transform[(0, 1)],
                position_transform[(1, 1)],
                position_transform[(2, 1)],
            );
            let rot_z = Vector3::new(
                position_transform[(0, 2)],
                position_transform[(1, 2)],
                position_transform[(2, 2)],
            );
            (rot_x * local_extrusion_direction.x
                + rot_y * local_extrusion_direction.y
                + rot_z * local_extrusion_direction.z)
                .normalize()
        };

        // Get element placement transform
        let element_transform = self.get_placement_transform_from_element(element, decoder)?;
        let combined_transform = element_transform * position_transform;

        // Get swept area (profile) - attribute 0
        let profile_attr = match extrusion.get(0) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok(None),
        };

        let profile_entity = match decoder.resolve_ref(profile_attr)? {
            Some(e) => e,
            None => return Ok(None),
        };

        // Extract base 2D profile
        let base_profile = match self.extract_profile_2d(&profile_entity, decoder) {
            Ok(p) => p,
            Err(_) => return Ok(None),
        };

        // Process opening meshes and classify them
        let mut void_meshes: Vec<Mesh> = Vec::new();

        for &opening_id in opening_ids {
            let opening_entity = match decoder.decode_by_id(opening_id) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let opening_mesh = match self.process_element(&opening_entity, decoder) {
                Ok(m) if !m.is_empty() => m,
                _ => continue,
            };

            void_meshes.push(opening_mesh);
        }

        if void_meshes.is_empty() {
            // No valid openings - just process the extrusion normally
            let processor = self.processors.get(&IfcType::IfcExtrudedAreaSolid);
            if let Some(proc) = processor {
                let mut mesh = proc.process(extrusion, decoder, &self.schema)?;
                self.scale_mesh(&mut mesh);
                self.apply_placement(element, decoder, &mut mesh)?;
                return Ok(Some(mesh));
            }
            return Ok(None);
        }

        // Classify voids
        // Use unscaled depth since void_meshes are in file units (not yet scaled)
        let analyzer = VoidAnalyzer::new();

        let classifications: Vec<crate::void_analysis::VoidClassification> = void_meshes
            .iter()
            .map(|mesh| {
                analyzer.classify_void(
                    mesh,
                    &combined_transform,
                    &extrusion_direction.normalize(),
                    depth,
                )
            })
            .collect();

        // Extract coplanar and non-planar voids
        let coplanar_voids = extract_coplanar_voids(&classifications);
        let nonplanar_voids = extract_nonplanar_voids(classifications);

        // Process coplanar voids at 2D level
        let profile_with_voids = if !coplanar_voids.is_empty() {
            // Collect through-void contours for 2D subtraction
            let through_contours: Vec<Vec<Point2<f64>>> = coplanar_voids
                .iter()
                .filter(|v| v.is_through)
                .map(|v| v.contour.clone())
                .collect();

            // Subtract voids from profile
            let modified_profile = if !through_contours.is_empty() {
                match subtract_multiple_2d(&base_profile, &through_contours) {
                    Ok(p) => p,
                    Err(_) => base_profile.clone(),
                }
            } else {
                base_profile.clone()
            };

            // Create profile with partial-depth voids
            let partial_voids: Vec<VoidInfo> = coplanar_voids
                .into_iter()
                .filter(|v| !v.is_through)
                .map(|v| VoidInfo {
                    contour: v.contour,
                    depth_start: v.depth_start,
                    depth_end: v.depth_end,
                    is_through: false,
                })
                .collect();

            Profile2DWithVoids::new(modified_profile, partial_voids)
        } else {
            Profile2DWithVoids::from_profile(base_profile)
        };

        // Extrude with voids
        use crate::extrusion::extrude_profile_with_voids;

        let mut mesh = match extrude_profile_with_voids(&profile_with_voids, depth, None) {
            Ok(m) => m,
            Err(_) => {
                // Fall back to normal extrusion
                let processor = self.processors.get(&IfcType::IfcExtrudedAreaSolid);
                if let Some(proc) = processor {
                    proc.process(extrusion, decoder, &self.schema)?
                } else {
                    return Ok(None);
                }
            }
        };

        // Apply extrusion position transform in local representation space.
        if position_transform != Matrix4::identity() {
            self.transform_mesh_local(&mut mesh, &position_transform);
        }

        // Scale mesh
        self.scale_mesh(&mut mesh);

        // Apply element placement
        self.apply_placement(element, decoder, &mut mesh)?;

        // Handle non-planar voids with 3D CSG
        if !nonplanar_voids.is_empty() {
            let clipper = ClippingProcessor::new();
            mesh = clipper.subtract_meshes_with_fallback(&mesh, &nonplanar_voids);
        }

        Ok(Some(mesh))
    }

    /// Extract a 2D profile from an IFC profile entity
    pub(super) fn extract_profile_2d(
        &self,
        profile_entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Profile2D> {
        use crate::profile::create_rectangle;

        match profile_entity.ifc_type {
            IfcType::IfcRectangleProfileDef => {
                // Attributes: ProfileType, ProfileName, Position, XDim, YDim
                let x_dim = profile_entity.get_float(3).unwrap_or(1.0);
                let y_dim = profile_entity.get_float(4).unwrap_or(1.0);
                Ok(create_rectangle(x_dim, y_dim))
            }

            IfcType::IfcCircleProfileDef => {
                use crate::profile::create_circle;
                let radius = profile_entity.get_float(3).unwrap_or(1.0);
                Ok(create_circle(radius, None))
            }

            IfcType::IfcArbitraryClosedProfileDef => {
                // Get outer curve and convert to points
                let curve_attr = profile_entity.get(2).ok_or_else(|| {
                    Error::geometry("ArbitraryClosedProfileDef missing OuterCurve".to_string())
                })?;

                let curve = decoder
                    .resolve_ref(curve_attr)?
                    .ok_or_else(|| Error::geometry("Failed to resolve OuterCurve".to_string()))?;

                let points = self.extract_curve_points(&curve, decoder)?;
                Ok(Profile2D::new(points))
            }

            IfcType::IfcArbitraryProfileDefWithVoids => {
                // Get outer curve
                let outer_attr = profile_entity.get(2).ok_or_else(|| {
                    Error::geometry("ArbitraryProfileDefWithVoids missing OuterCurve".to_string())
                })?;

                let outer_curve = decoder
                    .resolve_ref(outer_attr)?
                    .ok_or_else(|| Error::geometry("Failed to resolve OuterCurve".to_string()))?;

                let outer_points = self.extract_curve_points(&outer_curve, decoder)?;
                let mut profile = Profile2D::new(outer_points);

                // Get inner curves (holes)
                if let Some(inner_attr) = profile_entity.get(3) {
                    let inner_curves = decoder.resolve_ref_list(inner_attr)?;
                    for inner_curve in inner_curves {
                        if let Ok(hole_points) = self.extract_curve_points(&inner_curve, decoder) {
                            profile.add_hole(hole_points);
                        }
                    }
                }

                Ok(profile)
            }

            _ => Err(Error::geometry(format!(
                "Unsupported profile type for 2D extraction: {}",
                profile_entity.ifc_type
            ))),
        }
    }

    /// Extract points from a curve entity (IfcPolyline, IfcIndexedPolyCurve, etc.)
    fn extract_curve_points(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        match curve.ifc_type {
            IfcType::IfcPolyline => {
                // IfcPolyline: Points (list of IfcCartesianPoint)
                let points_attr = curve
                    .get(0)
                    .ok_or_else(|| Error::geometry("IfcPolyline missing Points".to_string()))?;

                let point_entities = decoder.resolve_ref_list(points_attr)?;
                let mut points = Vec::with_capacity(point_entities.len());

                for (_i, point_entity) in point_entities.iter().enumerate() {
                    if point_entity.ifc_type == IfcType::IfcCartesianPoint {
                        if let Some(coords_attr) = point_entity.get(0) {
                            if let Some(coords) = coords_attr.as_list() {
                                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                                points.push(Point2::new(x, y));
                            }
                        }
                    }
                }

                Ok(points)
            }

            IfcType::IfcIndexedPolyCurve => {
                // IfcIndexedPolyCurve: Points (IfcCartesianPointList2D), Segments, SelfIntersect
                let points_attr = curve.get(0).ok_or_else(|| {
                    Error::geometry("IfcIndexedPolyCurve missing Points".to_string())
                })?;

                let point_list = decoder
                    .resolve_ref(points_attr)?
                    .ok_or_else(|| Error::geometry("Failed to resolve Points".to_string()))?;

                // IfcCartesianPointList2D: CoordList (list of coordinates)
                if let Some(coord_attr) = point_list.get(0) {
                    if let Some(coord_list) = coord_attr.as_list() {
                        let mut points = Vec::with_capacity(coord_list.len());

                        for coord in coord_list {
                            if let Some(pair) = coord.as_list() {
                                let x = pair.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                                let y = pair.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                                points.push(Point2::new(x, y));
                            }
                        }

                        return Ok(points);
                    }
                }

                Err(Error::geometry(
                    "Failed to extract points from IfcIndexedPolyCurve".to_string(),
                ))
            }

            IfcType::IfcCompositeCurve => {
                // IfcCompositeCurve: Segments (list of IfcCompositeCurveSegment)
                let segments_attr = curve.get(0).ok_or_else(|| {
                    Error::geometry("IfcCompositeCurve missing Segments".to_string())
                })?;

                let segments = decoder.resolve_ref_list(segments_attr)?;
                let mut all_points = Vec::new();

                for segment in segments {
                    // IfcCompositeCurveSegment: Transition, SameSense, ParentCurve
                    if let Some(parent_attr) = segment.get(2) {
                        if let Some(parent_curve) = decoder.resolve_ref(parent_attr)? {
                            if let Ok(points) = self.extract_curve_points(&parent_curve, decoder) {
                                all_points.extend(points);
                            }
                        }
                    }
                }

                Ok(all_points)
            }

            _ => Err(Error::geometry(format!(
                "Unsupported curve type: {}",
                curve.ifc_type
            ))),
        }
    }
}
