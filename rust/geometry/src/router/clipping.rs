// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Boolean clipping result extraction: half-space planes and profile drilling.
//!
//! NOTE (issue #635): the helpers in this module are currently unused by the
//! production void path. They were previously called by
//! `GeometryRouter::build_void_context` to re-apply `IfcBooleanClippingResult`
//! planes after void subtraction, but that re-application discarded the
//! polygonal bound from `IfcPolygonalBoundedHalfSpace` and chopped off gable
//! peaks (AC20-FZK-Haus). Boolean clipping is now applied entirely by
//! `BooleanClippingProcessor::process` during representation traversal. The
//! helpers are kept (gated `#[allow(dead_code)]`) for callers that want to
//! pre-extract the base wall profile + clip planes — e.g. layered-wall
//! triangulation that needs both pre- and post-clip silhouettes.

use super::GeometryRouter;
use crate::{Error, Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use rustc_hash::FxHashSet;

/// Maximum IfcBooleanClippingResult chain depth we will follow when extracting a base profile.
#[allow(dead_code)]
const MAX_CLIPPING_DEPTH: usize = 32;

impl GeometryRouter {
    /// Quick check if an element has clipping planes (IfcBooleanClippingResult in representation)
    /// This is much faster than extract_base_profile_and_clips and allows skipping expensive
    /// extraction for the ~95% of elements that don't have clipping.
    #[inline]
    #[allow(dead_code)] // see module-level note (issue #635)
    pub(super) fn has_clipping_planes(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> bool {
        // Get representation
        let representation_attr = match element.get(6) {
            Some(attr) => attr,
            None => return false,
        };

        let representation = match decoder.resolve_ref(representation_attr) {
            Ok(Some(r)) if r.ifc_type == IfcType::IfcProductDefinitionShape => r,
            _ => return false,
        };

        // Get representations list
        let representations_attr = match representation.get(2) {
            Some(attr) => attr,
            None => return false,
        };

        let representations = match decoder.resolve_ref_list(representations_attr) {
            Ok(r) => r,
            Err(_) => return false,
        };

        // Check if any representation item is IfcBooleanClippingResult
        for shape_rep in &representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            let items_attr = match shape_rep.get(3) {
                Some(attr) => attr,
                None => continue,
            };

            let items = match decoder.resolve_ref_list(items_attr) {
                Ok(i) => i,
                Err(_) => continue,
            };

            for item in &items {
                if item.ifc_type == IfcType::IfcBooleanClippingResult {
                    return true;
                }
            }
        }

        false
    }

    /// Extract base wall profile, depth, axis info, Position transform, and clipping planes
    ///
    /// Drills through IfcBooleanClippingResult to find the base extruded solid,
    /// extracts its actual 2D profile (preserving chamfered corners), and collects clipping planes.
    /// Returns: (profile, depth, thickness_axis, wall_origin, position_transform, clipping_planes)
    #[allow(dead_code)] // see module-level note (issue #635)
    pub(super) fn extract_base_profile_and_clips(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(
        crate::profile::Profile2D,
        f64,
        u8,
        f64,
        Option<Matrix4<f64>>,
        Vec<(Point3<f64>, Vector3<f64>, bool)>,
    )> {
        use nalgebra::Vector3;

        let mut clipping_planes: Vec<(Point3<f64>, Vector3<f64>, bool)> = Vec::new();

        // Get representation
        let representation_attr = element
            .get(6)
            .ok_or_else(|| Error::geometry("Element missing representation".to_string()))?;

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;

        if representation.ifc_type != IfcType::IfcProductDefinitionShape {
            // Fallback: can't extract profile, return error
            return Err(Error::geometry(
                "Element representation is not ProductDefinitionShape".to_string(),
            ));
        }

        // Get representations list
        let representations_attr = representation
            .get(2)
            .ok_or_else(|| Error::geometry("Missing representations".to_string()))?;

        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Find the shape representation with geometry
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
                // Check if this is a IfcBooleanClippingResult (wall clipped by roof)
                if item.ifc_type == IfcType::IfcBooleanClippingResult {
                    // Recursively extract base solid and collect clipping planes
                    let (profile, depth, axis, origin, transform, clips) =
                        self.extract_profile_from_boolean_result(item, decoder)?;
                    clipping_planes.extend(clips);
                    return Ok((profile, depth, axis, origin, transform, clipping_planes));
                }

                // If it's a simple extruded solid, extract profile directly
                if item.ifc_type == IfcType::IfcExtrudedAreaSolid {
                    let (profile, depth, axis, origin, transform) =
                        self.extract_profile_from_extruded_solid(item, decoder)?;
                    return Ok((profile, depth, axis, origin, transform, clipping_planes));
                }
            }
        }

        // Fallback: couldn't find extruded solid
        Err(Error::geometry(
            "Could not find IfcExtrudedAreaSolid in representation".to_string(),
        ))
    }

    /// Extract profile from IfcBooleanClippingResult recursively
    #[allow(dead_code)] // see module-level note (issue #635)
    fn extract_profile_from_boolean_result(
        &self,
        boolean_result: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(
        crate::profile::Profile2D,
        f64,
        u8,
        f64,
        Option<Matrix4<f64>>,
        Vec<(Point3<f64>, Vector3<f64>, bool)>,
    )> {
        use nalgebra::Vector3;

        let mut clipping_planes: Vec<(Point3<f64>, Vector3<f64>, bool)> = Vec::new();
        let mut current = boolean_result.clone();
        let mut visited = FxHashSet::default();

        for _depth in 0..MAX_CLIPPING_DEPTH {
            if !visited.insert(current.id) {
                return Err(Error::geometry(format!(
                    "Detected cyclic IfcBooleanClippingResult reference at #{}",
                    current.id
                )));
            }

            // Get SecondOperand (the clipping solid - usually IfcHalfSpaceSolid)
            if let Some(second_operand_attr) = current.get(2) {
                if let Ok(Some(second_operand)) = decoder.resolve_ref(second_operand_attr) {
                    if let Some(clip) = self.extract_half_space_plane(&second_operand, decoder) {
                        clipping_planes.push(clip);
                    }
                }
            }

            // Get FirstOperand (the base geometry or another boolean result)
            let first_operand_attr = current
                .get(1)
                .ok_or_else(|| Error::geometry("BooleanResult missing FirstOperand".to_string()))?;

            let first_operand = decoder
                .resolve_ref(first_operand_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand".to_string()))?;

            if first_operand.ifc_type == IfcType::IfcBooleanClippingResult {
                current = first_operand;
                continue;
            }

            // FirstOperand should be IfcExtrudedAreaSolid
            if first_operand.ifc_type == IfcType::IfcExtrudedAreaSolid {
                let (profile, depth, axis, origin, transform) =
                    self.extract_profile_from_extruded_solid(&first_operand, decoder)?;
                return Ok((profile, depth, axis, origin, transform, clipping_planes));
            }

            return Err(Error::geometry(format!(
                "Unsupported base solid type in boolean result: {:?}",
                first_operand.ifc_type
            )));
        }

        Err(Error::geometry(format!(
            "IfcBooleanClippingResult nesting exceeded maximum depth of {} at #{}",
            MAX_CLIPPING_DEPTH, current.id
        )))
    }

    /// Extract profile, depth, axis, origin, and Position transform from IfcExtrudedAreaSolid
    #[allow(dead_code)] // see module-level note (issue #635)
    fn extract_profile_from_extruded_solid(
        &self,
        extruded_solid: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(
        crate::profile::Profile2D,
        f64,
        u8,
        f64,
        Option<Matrix4<f64>>,
    )> {
        // Get SweptArea (attribute 0: IfcProfileDef)
        let swept_area_attr = extruded_solid
            .get(0)
            .ok_or_else(|| Error::geometry("ExtrudedAreaSolid missing SweptArea".to_string()))?;

        let profile_entity = decoder
            .resolve_ref(swept_area_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve SweptArea".to_string()))?;

        // Extract the actual 2D profile (preserves chamfered corners!)
        let profile = self.extract_profile_2d(&profile_entity, decoder)?;

        // Get depth (attribute 3: Depth)
        let depth = extruded_solid
            .get_float(3)
            .ok_or_else(|| Error::geometry("ExtrudedAreaSolid missing Depth".to_string()))?;

        // Get ExtrudedDirection (attribute 2: IfcDirection)
        // This tells us which axis is the thickness axis
        let direction_attr = extruded_solid.get(2).ok_or_else(|| {
            Error::geometry("ExtrudedAreaSolid missing ExtrudedDirection".to_string())
        })?;

        let direction_entity = decoder
            .resolve_ref(direction_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve ExtrudedDirection".to_string()))?;

        // Get direction coordinates (attribute 0: DirectionRatios)
        let ratios_attr = direction_entity
            .get(0)
            .ok_or_else(|| Error::geometry("Direction missing DirectionRatios".to_string()))?;

        let ratios = ratios_attr
            .as_list()
            .ok_or_else(|| Error::geometry("DirectionRatios is not a list".to_string()))?;

        let dx = ratios.get(0).and_then(|v| v.as_float()).unwrap_or(0.0);
        let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        let dz = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(1.0);

        // Determine thickness axis from direction (which component is largest)
        let thickness_axis = if dx.abs() >= dy.abs() && dx.abs() >= dz.abs() {
            0 // X axis
        } else if dy.abs() >= dz.abs() {
            1 // Y axis
        } else {
            2 // Z axis
        };

        // For wall origin, we'll need to get it from the element's placement
        // For now, use 0.0 - it will be adjusted when we transform coordinates
        let wall_origin = 0.0;

        // Extract Position transform (attribute 1: IfcAxis2Placement3D)
        let position_transform = if let Some(pos_attr) = extruded_solid.get(1) {
            if !pos_attr.is_null() {
                if let Ok(Some(pos_entity)) = decoder.resolve_ref(pos_attr) {
                    if pos_entity.ifc_type == IfcType::IfcAxis2Placement3D {
                        match self.parse_axis2_placement_3d(&pos_entity, decoder) {
                            Ok(transform) => Some(transform),
                            Err(_) => None,
                        }
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

        Ok((
            profile,
            depth,
            thickness_axis,
            wall_origin,
            position_transform,
        ))
    }

    /// Extract base mesh from IfcBooleanClippingResult and collect clipping planes
    #[allow(dead_code)] // Used internally for recursive boolean result processing
    fn extract_base_from_boolean_result(
        &self,
        boolean_result: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Mesh, Vec<(Point3<f64>, Vector3<f64>, bool)>)> {
        use nalgebra::Vector3;

        let mut clipping_planes: Vec<(Point3<f64>, Vector3<f64>, bool)> = Vec::new();

        // Get FirstOperand (the base geometry or another boolean result)
        let first_operand_attr = boolean_result
            .get(1)
            .ok_or_else(|| Error::geometry("BooleanResult missing FirstOperand".to_string()))?;

        let first_operand = decoder
            .resolve_ref(first_operand_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand".to_string()))?;

        // Get SecondOperand (the clipping solid - usually IfcHalfSpaceSolid)
        if let Some(second_operand_attr) = boolean_result.get(2) {
            if let Ok(Some(second_operand)) = decoder.resolve_ref(second_operand_attr) {
                if let Some(clip) = self.extract_half_space_plane(&second_operand, decoder) {
                    clipping_planes.push(clip);
                }
            }
        }

        // Process FirstOperand
        if first_operand.ifc_type == IfcType::IfcBooleanClippingResult {
            // Recursively process nested boolean results
            let (base_mesh, nested_clips) =
                self.extract_base_from_boolean_result(&first_operand, decoder)?;
            clipping_planes.extend(nested_clips);
            return Ok((base_mesh, clipping_planes));
        }

        // FirstOperand is the base solid (IfcExtrudedAreaSolid, etc.)
        if let Some(processor) = self.processors.get(&first_operand.ifc_type) {
            let mut mesh = processor.process(&first_operand, decoder, &self.schema)?;
            self.scale_mesh(&mut mesh);
            // Note: placement is applied in the main function
            return Ok((mesh, clipping_planes));
        }

        Err(Error::geometry(format!(
            "Unsupported base solid type: {:?}",
            first_operand.ifc_type
        )))
    }

    /// Extract plane parameters from IfcHalfSpaceSolid or IfcPolygonalBoundedHalfSpace
    fn extract_half_space_plane(
        &self,
        half_space: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(Point3<f64>, Vector3<f64>, bool)> {
        use nalgebra::Vector3;

        if half_space.ifc_type != IfcType::IfcHalfSpaceSolid
            && half_space.ifc_type != IfcType::IfcPolygonalBoundedHalfSpace
        {
            return None;
        }

        // Get BaseSurface (should be IfcPlane)
        let base_surface_attr = half_space.get(0)?;
        let base_surface = decoder.resolve_ref(base_surface_attr).ok()??;

        if base_surface.ifc_type != IfcType::IfcPlane {
            return None;
        }

        // Get Position (IfcAxis2Placement3D)
        let position_attr = base_surface.get(0)?;
        let position = decoder.resolve_ref(position_attr).ok()??;

        // Get Location (point on plane)
        let location_attr = position.get(0)?;
        let location = decoder.resolve_ref(location_attr).ok()??;

        let coords_attr = location.get(0)?;
        let coords = coords_attr.as_list()?;
        let px = coords.first()?.as_float()?;
        let py = coords.get(1)?.as_float()?;
        let pz = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
        let plane_point = Point3::new(px, py, pz);

        // Get Axis (normal direction) - default to Z if not specified
        let plane_normal = if let Some(axis_attr) = position.get(1) {
            if !axis_attr.is_null() {
                if let Ok(Some(axis)) = decoder.resolve_ref(axis_attr) {
                    if let Some(dir_attr) = axis.get(0) {
                        if let Some(dir) = dir_attr.as_list() {
                            let nx = dir.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                            let ny = dir.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                            let nz = dir.get(2).and_then(|v| v.as_float()).unwrap_or(1.0);
                            Vector3::new(nx, ny, nz).normalize()
                        } else {
                            Vector3::new(0.0, 0.0, 1.0)
                        }
                    } else {
                        Vector3::new(0.0, 0.0, 1.0)
                    }
                } else {
                    Vector3::new(0.0, 0.0, 1.0)
                }
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            }
        } else {
            Vector3::new(0.0, 0.0, 1.0)
        };

        // Get AgreementFlag - stored as Enum "T" or "F"
        let agreement = half_space
            .get(1)
            .map(|v| match v {
                ifc_lite_core::AttributeValue::Enum(e) => e != "F" && e != ".F.",
                _ => true,
            })
            .unwrap_or(true);

        Some((plane_point, plane_normal, agreement))
    }
}
