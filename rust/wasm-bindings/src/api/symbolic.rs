// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Symbolic representation parsing for IFC-Lite API (2D curves for architectural drawings)

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Parse IFC file and extract symbolic representations (Plan, Annotation, FootPrint)
    /// These are 2D curves used for architectural drawings instead of sectioning 3D geometry
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// const symbols = api.parseSymbolicRepresentations(ifcData);
    /// console.log('Found', symbols.totalCount, 'symbolic items');
    /// for (let i = 0; i < symbols.polylineCount; i++) {
    ///   const polyline = symbols.getPolyline(i);
    ///   console.log('Polyline for', polyline.ifcType, ':', polyline.points);
    /// }
    /// ```
    #[wasm_bindgen(js_name = parseSymbolicRepresentations)]
    pub fn parse_symbolic_representations(
        &self,
        content: String,
    ) -> crate::zero_copy::SymbolicRepresentationCollection {
        use crate::zero_copy::SymbolicRepresentationCollection;
        use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};

        // Build entity index for fast lookups
        let entity_index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);

        // Create geometry router to get unit scale and detect RTC offset
        let router = ifc_lite_geometry::GeometryRouter::with_units(&content, &mut decoder);
        let unit_scale = router.unit_scale() as f32;

        // Detect RTC offset (same as mesh parsing) to align with section cuts
        let rtc_offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);
        let needs_rtc = rtc_offset.0.abs() > 10000.0
            || rtc_offset.1.abs() > 10000.0
            || rtc_offset.2.abs() > 10000.0;

        // RTC offset for floor plan: use X and Z (Y is vertical)
        let rtc_x = if needs_rtc { rtc_offset.0 as f32 } else { 0.0 };
        let rtc_z = if needs_rtc { rtc_offset.2 as f32 } else { 0.0 };

        let mut collection = SymbolicRepresentationCollection::new();
        let mut scanner = EntityScanner::new(&content);

        // Process all building elements that might have symbolic representations
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            // Check if this is a building element type
            if !ifc_lite_core::has_geometry_by_name(type_name) {
                continue;
            }

            // Decode the entity
            let entity = match decoder.decode_at_with_id(id, start, end) {
                Ok(e) => e,
                Err(_) => continue,
            };

            // Get representation (attribute 6 for most products)
            // Note: placement transform is computed per-representation below
            let representation_attr = match entity.get(6) {
                Some(attr) if !attr.is_null() => attr,
                _ => continue,
            };

            let representation = match decoder.resolve_ref(representation_attr) {
                Ok(Some(r)) => r,
                _ => continue,
            };

            // Get representations list (attribute 2 of IfcProductDefinitionShape)
            let representations_attr = match representation.get(2) {
                Some(attr) => attr,
                None => continue,
            };

            let representations = match decoder.resolve_ref_list(representations_attr) {
                Ok(r) => r,
                Err(_) => continue,
            };

            let ifc_type_name = entity.ifc_type.name().to_string();

            // Look for Plan, Annotation, or FootPrint representations
            for shape_rep in representations {
                if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                    continue;
                }

                // Get RepresentationIdentifier (attribute 1)
                let rep_identifier = match shape_rep.get(1) {
                    Some(attr) => attr.as_string().unwrap_or("").to_string(),
                    None => continue,
                };

                // Only process symbolic representations
                if !matches!(
                    rep_identifier.as_str(),
                    "Plan" | "Annotation" | "FootPrint" | "Axis"
                ) {
                    continue;
                }

                // Get ObjectPlacement transform for symbolic representations.
                // - Translations are accumulated directly (not rotated by parent)
                // - Rotations ARE accumulated to orient symbols correctly
                let placement_transform = get_object_placement_for_symbolic_logged(
                    &entity,
                    &mut decoder,
                    unit_scale,
                    None,
                );

                // Check ContextOfItems (attribute 0) for WorldCoordinateSystem
                // Some Plan representations use a different coordinate system than Body
                let context_transform = if let Some(context_ref) = shape_rep.get_ref(0) {
                    if let Ok(context) = decoder.decode_by_id(context_ref) {
                        // IfcGeometricRepresentationContext has WorldCoordinateSystem at attr 2
                        // IfcGeometricRepresentationSubContext inherits from parent (attr 4)
                        if context.ifc_type == IfcType::IfcGeometricRepresentationContext {
                            if let Some(wcs_ref) = context.get_ref(2) {
                                if let Ok(wcs) = decoder.decode_by_id(wcs_ref) {
                                    parse_axis2_placement_2d(&wcs, &mut decoder, unit_scale)
                                } else {
                                    Transform2D::identity()
                                }
                            } else {
                                Transform2D::identity()
                            }
                        } else if context.ifc_type == IfcType::IfcGeometricRepresentationSubContext
                        {
                            // SubContext inherits from parent - for now use identity
                            // TODO: could recursively get parent context's WCS
                            Transform2D::identity()
                        } else {
                            Transform2D::identity()
                        }
                    } else {
                        Transform2D::identity()
                    }
                } else {
                    Transform2D::identity()
                };

                // Compose: context_transform * placement_transform
                // The context WCS defines global positioning, placement is entity-specific
                let combined_transform = if context_transform.tx.abs() > 0.001
                    || context_transform.ty.abs() > 0.001
                    || (context_transform.cos_theta - 1.0).abs() > 0.0001
                    || context_transform.sin_theta.abs() > 0.0001
                {
                    compose_transforms(&context_transform, &placement_transform)
                } else {
                    placement_transform.clone()
                };

                // Get items list (attribute 3)
                let items_attr = match shape_rep.get(3) {
                    Some(attr) => attr,
                    None => continue,
                };

                let items = match decoder.resolve_ref_list(items_attr) {
                    Ok(i) => i,
                    Err(_) => continue,
                };

                // Process each item in the representation
                for item in items {
                    extract_symbolic_item(
                        &item,
                        &mut decoder,
                        id,
                        &ifc_type_name,
                        &rep_identifier,
                        unit_scale,
                        &combined_transform,
                        rtc_x,
                        rtc_z,
                        &mut collection,
                    );
                }
            }
        }

        // Log bounding box of all symbolic geometry
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        for i in 0..collection.polyline_count() {
            if let Some(poly) = collection.get_polyline(i) {
                let points_array = poly.points();
                let points: Vec<f32> = points_array.to_vec();
                for chunk in points.chunks(2) {
                    if chunk.len() == 2 {
                        min_x = min_x.min(chunk[0]);
                        max_x = max_x.max(chunk[0]);
                        min_y = min_y.min(chunk[1]);
                        max_y = max_y.max(chunk[1]);
                    }
                }
            }
        }
        for i in 0..collection.circle_count() {
            if let Some(circle) = collection.get_circle(i) {
                min_x = min_x.min(circle.center_x() - circle.radius());
                max_x = max_x.max(circle.center_x() + circle.radius());
                min_y = min_y.min(circle.center_y() - circle.radius());
                max_y = max_y.max(circle.center_y() + circle.radius());
            }
        }

        collection
    }
}

/// Simple 2D transform for symbolic representations (translation + rotation)
#[derive(Clone, Copy, Debug)]
struct Transform2D {
    tx: f32,
    ty: f32,
    cos_theta: f32,
    sin_theta: f32,
}

impl Transform2D {
    fn identity() -> Self {
        Self {
            tx: 0.0,
            ty: 0.0,
            cos_theta: 1.0,
            sin_theta: 0.0,
        }
    }

    fn transform_point(&self, x: f32, y: f32) -> (f32, f32) {
        // Apply rotation then translation: p' = R * p + t
        let rx = x * self.cos_theta - y * self.sin_theta;
        let ry = x * self.sin_theta + y * self.cos_theta;
        (rx + self.tx, ry + self.ty)
    }
}

/// Compose two 2D transforms: result = a * b (apply b first, then a)
fn compose_transforms(a: &Transform2D, b: &Transform2D) -> Transform2D {
    // Combined rotation: R_combined = R_a * R_b
    let combined_cos = a.cos_theta * b.cos_theta - a.sin_theta * b.sin_theta;
    let combined_sin = a.sin_theta * b.cos_theta + a.cos_theta * b.sin_theta;

    // Combined translation: t_combined = R_a * t_b + t_a
    let rtx = b.tx * a.cos_theta - b.ty * a.sin_theta;
    let rty = b.tx * a.sin_theta + b.ty * a.cos_theta;

    Transform2D {
        tx: rtx + a.tx,
        ty: rty + a.ty,
        cos_theta: combined_cos,
        sin_theta: combined_sin,
    }
}

/// Get placement transform for symbolic 2D representations with logging.
fn get_object_placement_for_symbolic_logged(
    entity: &ifc_lite_core::DecodedEntity,
    decoder: &mut ifc_lite_core::EntityDecoder,
    unit_scale: f32,
    log_entity_id: Option<u32>,
) -> Transform2D {
    // Get ObjectPlacement (attribute 5 for IfcProduct)
    let placement_attr = match entity.get(5) {
        Some(attr) if !attr.is_null() => attr,
        _ => return Transform2D::identity(),
    };

    let placement = match decoder.resolve_ref(placement_attr) {
        Ok(Some(p)) => p,
        _ => return Transform2D::identity(),
    };

    // Recursively resolve for symbolic representations with logging
    resolve_placement_for_symbolic_with_logging(&placement, decoder, unit_scale, 0, log_entity_id)
}

/// Recursively resolve IfcLocalPlacement for 2D symbolic representations.
/// Translations are accumulated directly (without rotating by parent rotations),
/// but rotations ARE accumulated to orient the 2D geometry correctly.
fn resolve_placement_for_symbolic_with_logging(
    placement: &ifc_lite_core::DecodedEntity,
    decoder: &mut ifc_lite_core::EntityDecoder,
    unit_scale: f32,
    depth: usize,
    log_entity_id: Option<u32>,
) -> Transform2D {
    use ifc_lite_core::IfcType;

    // Prevent infinite recursion
    if depth > 50 || placement.ifc_type != IfcType::IfcLocalPlacement {
        return Transform2D::identity();
    }

    // Get parent transform first (attribute 0: PlacementRelTo)
    let parent_transform = if let Some(parent_attr) = placement.get(0) {
        if !parent_attr.is_null() {
            if let Ok(Some(parent)) = decoder.resolve_ref(parent_attr) {
                resolve_placement_for_symbolic_with_logging(
                    &parent,
                    decoder,
                    unit_scale,
                    depth + 1,
                    log_entity_id,
                )
            } else {
                Transform2D::identity()
            }
        } else {
            Transform2D::identity()
        }
    } else {
        Transform2D::identity()
    };

    // Get local transform (attribute 1: RelativePlacement)
    let local_transform = if let Some(rel_attr) = placement.get(1) {
        if !rel_attr.is_null() {
            if let Ok(Some(rel)) = decoder.resolve_ref(rel_attr) {
                if rel.ifc_type == IfcType::IfcAxis2Placement3D
                    || rel.ifc_type == IfcType::IfcAxis2Placement2D
                {
                    parse_axis2_placement_2d(&rel, decoder, unit_scale)
                } else {
                    Transform2D::identity()
                }
            } else {
                Transform2D::identity()
            }
        } else {
            Transform2D::identity()
        }
    } else {
        Transform2D::identity()
    };

    // For symbolic 2D representations:
    // - Translations are added directly (NOT rotated by parent rotation)
    // - Rotations are accumulated to orient the 2D geometry
    // This prevents parent rotations from distorting child positions while
    // still allowing correct orientation of symbols.
    // Compose transforms properly: rotate local translation by parent rotation
    let combined_cos = parent_transform.cos_theta * local_transform.cos_theta
        - parent_transform.sin_theta * local_transform.sin_theta;
    let combined_sin = parent_transform.sin_theta * local_transform.cos_theta
        + parent_transform.cos_theta * local_transform.sin_theta;

    // Rotate local translation by parent rotation before adding to parent translation
    let rotated_local_tx = local_transform.tx * parent_transform.cos_theta
        - local_transform.ty * parent_transform.sin_theta;
    let rotated_local_ty = local_transform.tx * parent_transform.sin_theta
        + local_transform.ty * parent_transform.cos_theta;

    let composed_tx = parent_transform.tx + rotated_local_tx;
    let composed_ty = parent_transform.ty + rotated_local_ty;
    let _composed_rot = combined_sin.atan2(combined_cos).to_degrees();

    Transform2D {
        tx: composed_tx,
        ty: composed_ty,
        cos_theta: combined_cos,
        sin_theta: combined_sin,
    }
}

/// Parse IfcAxis2Placement3D/2D to get 2D translation and rotation for floor plan view
/// Floor plan uses X-Y plane (Z is up) to match section cut coordinate system
fn parse_axis2_placement_2d(
    placement: &ifc_lite_core::DecodedEntity,
    decoder: &mut ifc_lite_core::EntityDecoder,
    unit_scale: f32,
) -> Transform2D {
    parse_axis2_placement_2d_with_logging(placement, decoder, unit_scale, false, 0)
}

/// Parse IfcAxis2Placement3D/2D with optional logging
fn parse_axis2_placement_2d_with_logging(
    placement: &ifc_lite_core::DecodedEntity,
    decoder: &mut ifc_lite_core::EntityDecoder,
    unit_scale: f32,
    _log: bool,
    _entity_id: u32,
) -> Transform2D {
    use ifc_lite_core::IfcType;

    // Get Location (attribute 0)
    // Floor plan coordinates use X-Y plane (Z is up) to match section cut
    let is_3d = placement.ifc_type == IfcType::IfcAxis2Placement3D;

    let (tx, ty, _raw_coords) = if let Some(loc_ref) = placement.get_ref(0) {
        if let Ok(loc) = decoder.decode_by_id(loc_ref) {
            if loc.ifc_type == IfcType::IfcCartesianPoint {
                if let Some(coords_attr) = loc.get(0) {
                    if let Some(coords) = coords_attr.as_list() {
                        let raw_x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                        let raw_y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                        let raw_z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;

                        // Use X-Y for floor plan (Z is up in most IFC models)
                        // Keep native IFC coordinates to match section cut
                        let x = raw_x * unit_scale;
                        let y = raw_y * unit_scale;
                        (x, y, Some((raw_x, raw_y, raw_z)))
                    } else {
                        (0.0, 0.0, None)
                    }
                } else {
                    (0.0, 0.0, None)
                }
            } else {
                (0.0, 0.0, None)
            }
        } else {
            (0.0, 0.0, None)
        }
    } else {
        (0.0, 0.0, None)
    };

    // Get RefDirection (attribute 2 for 3D, attribute 1 for 2D) to get rotation
    // RefDirection is the X-axis direction in the local coordinate system
    // Use X-Y components for floor plan rotation (Z is up)
    let ref_dir_attr = if placement.ifc_type == IfcType::IfcAxis2Placement3D {
        placement.get(2)
    } else {
        placement.get(1)
    };

    let (cos_theta, sin_theta) = if let Some(ref_dir_attr) = ref_dir_attr {
        if !ref_dir_attr.is_null() {
            if let Some(ref_dir_id) = ref_dir_attr.as_entity_ref() {
                if let Ok(ref_dir) = decoder.decode_by_id(ref_dir_id) {
                    if ref_dir.ifc_type == IfcType::IfcDirection {
                        if let Some(ratios_attr) = ref_dir.get(0) {
                            if let Some(ratios) = ratios_attr.as_list() {
                                let dx =
                                    ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
                                let dy =
                                    ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                                let dz =
                                    ratios.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;

                                // Use X-Y for rotation (Z is up)
                                let len = (dx * dx + dy * dy).sqrt();
                                if len > 0.0001 {
                                    (dx / len, dy / len)
                                } else if is_3d && dz.abs() > 0.0001 {
                                    // Special case: RefDirection is purely in Z direction (vertical)
                                    // Local X points up/down, rotation is 0° in floor plan
                                    (1.0, 0.0)
                                } else {
                                    (1.0, 0.0)
                                }
                            } else {
                                (1.0, 0.0)
                            }
                        } else {
                            (1.0, 0.0)
                        }
                    } else {
                        (1.0, 0.0)
                    }
                } else {
                    (1.0, 0.0)
                }
            } else {
                (1.0, 0.0)
            }
        } else {
            (1.0, 0.0)
        }
    } else {
        (1.0, 0.0)
    };

    Transform2D {
        tx,
        ty,
        cos_theta,
        sin_theta,
    }
}

/// Parse IfcCartesianTransformationOperator to get 2D transform
fn parse_cartesian_transformation_operator(
    operator: &ifc_lite_core::DecodedEntity,
    decoder: &mut ifc_lite_core::EntityDecoder,
    unit_scale: f32,
) -> Transform2D {
    use ifc_lite_core::IfcType;

    // IfcCartesianTransformationOperator: Axis1, Axis2, LocalOrigin, Scale
    // IfcCartesianTransformationOperator2D: same, but 2D
    // IfcCartesianTransformationOperator3D: Axis1, Axis2, LocalOrigin, Scale, Axis3

    // Get LocalOrigin (attribute 2 for 2D, attribute 2 for 3D)
    let (tx, ty) = if let Some(origin_ref) = operator.get_ref(2) {
        if let Ok(origin) = decoder.decode_by_id(origin_ref) {
            if origin.ifc_type == IfcType::IfcCartesianPoint {
                if let Some(coords_attr) = origin.get(0) {
                    if let Some(coords) = coords_attr.as_list() {
                        let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32
                            * unit_scale;
                        let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32
                            * unit_scale;
                        (x, y)
                    } else {
                        (0.0, 0.0)
                    }
                } else {
                    (0.0, 0.0)
                }
            } else {
                (0.0, 0.0)
            }
        } else {
            (0.0, 0.0)
        }
    } else {
        (0.0, 0.0)
    };

    // Get Axis1 for rotation (attribute 0)
    let (cos_theta, sin_theta) = if let Some(axis1_ref) = operator.get_ref(0) {
        if let Ok(axis1) = decoder.decode_by_id(axis1_ref) {
            if axis1.ifc_type == IfcType::IfcDirection {
                if let Some(ratios_attr) = axis1.get(0) {
                    if let Some(ratios) = ratios_attr.as_list() {
                        let dx = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
                        let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                        let len = (dx * dx + dy * dy).sqrt();
                        if len > 0.0001 {
                            (dx / len, dy / len)
                        } else {
                            (1.0, 0.0)
                        }
                    } else {
                        (1.0, 0.0)
                    }
                } else {
                    (1.0, 0.0)
                }
            } else {
                (1.0, 0.0)
            }
        } else {
            (1.0, 0.0)
        }
    } else {
        (1.0, 0.0)
    };

    Transform2D {
        tx,
        ty,
        cos_theta,
        sin_theta,
    }
}

/// Extract symbolic geometry from a representation item (recursive for IfcGeometricSet, IfcMappedItem)
fn extract_symbolic_item(
    item: &ifc_lite_core::DecodedEntity,
    decoder: &mut ifc_lite_core::EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    collection: &mut crate::zero_copy::SymbolicRepresentationCollection,
) {
    use crate::zero_copy::{SymbolicCircle, SymbolicPolyline};
    use ifc_lite_core::IfcType;

    match item.ifc_type {
        IfcType::IfcGeometricSet | IfcType::IfcGeometricCurveSet => {
            // IfcGeometricSet: Elements (SET of IfcGeometricSetSelect)
            if let Some(elements_attr) = item.get(0) {
                if let Ok(elements) = decoder.resolve_ref_list(elements_attr) {
                    for element in elements {
                        extract_symbolic_item(
                            &element,
                            decoder,
                            express_id,
                            ifc_type,
                            rep_identifier,
                            unit_scale,
                            transform,
                            rtc_x,
                            rtc_z,
                            collection,
                        );
                    }
                }
            }
        }
        IfcType::IfcMappedItem => {
            // IfcMappedItem: MappingSource (IfcRepresentationMap), MappingTarget (optional transform)
            if let Some(source_id) = item.get_ref(0) {
                if let Ok(rep_map) = decoder.decode_by_id(source_id) {
                    // IfcRepresentationMap: MappingOrigin, MappedRepresentation
                    // MappingOrigin (attr 0) defines the coordinate system origin for the mapped geometry
                    let mapping_origin_transform = if let Some(origin_id) = rep_map.get_ref(0) {
                        if let Ok(origin) = decoder.decode_by_id(origin_id) {
                            parse_axis2_placement_2d(&origin, decoder, unit_scale)
                        } else {
                            Transform2D::identity()
                        }
                    } else {
                        Transform2D::identity()
                    };

                    // Check for MappingTarget (attr 1 of IfcMappedItem) - additional transform
                    let mapping_target_transform = if let Some(target_ref) = item.get_ref(1) {
                        if let Ok(target) = decoder.decode_by_id(target_ref) {
                            // IfcCartesianTransformationOperator2D/3D
                            parse_cartesian_transformation_operator(&target, decoder, unit_scale)
                        } else {
                            Transform2D::identity()
                        }
                    } else {
                        Transform2D::identity()
                    };

                    // Compose: entity_transform * mapping_target * mapping_origin
                    // The mapping origin defines where the mapped geometry's (0,0) is relative to entity
                    // The mapping target provides additional transformation
                    let origin_with_target =
                        compose_transforms(&mapping_target_transform, &mapping_origin_transform);
                    let composed_transform = compose_transforms(transform, &origin_with_target);

                    if let Some(mapped_rep_id) = rep_map.get_ref(1) {
                        if let Ok(mapped_rep) = decoder.decode_by_id(mapped_rep_id) {
                            // Get items from the mapped representation
                            if let Some(items_attr) = mapped_rep.get(3) {
                                if let Ok(items) = decoder.resolve_ref_list(items_attr) {
                                    for sub_item in items {
                                        extract_symbolic_item(
                                            &sub_item,
                                            decoder,
                                            express_id,
                                            ifc_type,
                                            rep_identifier,
                                            unit_scale,
                                            &composed_transform,
                                            rtc_x,
                                            rtc_z,
                                            collection,
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        IfcType::IfcPolyline => {
            // IfcPolyline: Points (LIST of IfcCartesianPoint)
            if let Some(points_attr) = item.get(0) {
                if let Ok(point_entities) = decoder.resolve_ref_list(points_attr) {
                    let mut points: Vec<f32> = Vec::with_capacity(point_entities.len() * 2);

                    for point_entity in point_entities.iter() {
                        if point_entity.ifc_type != IfcType::IfcCartesianPoint {
                            continue;
                        }
                        if let Some(coords_attr) = point_entity.get(0) {
                            if let Some(coords) = coords_attr.as_list() {
                                let local_x =
                                    coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32
                                        * unit_scale;
                                let local_y =
                                    coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32
                                        * unit_scale;

                                // Apply full transform (rotation + translation) to orient symbols correctly.
                                // The placement's rotation is accumulated from hierarchy to orient
                                // door swings, window symbols, etc. properly.
                                let (wx, wy) = transform.transform_point(local_x, local_y);
                                let x = wx - rtc_x;
                                // Negate Y to match section cut coordinate system (renderer flips Y)
                                let y = -wy + rtc_z;

                                // Skip invalid coordinates
                                if x.is_finite() && y.is_finite() {
                                    points.push(x);
                                    points.push(y);
                                }
                            }
                        }
                    }
                    if points.len() >= 4 {
                        // Check if closed (first == last point)
                        let n = points.len();
                        let is_closed = n >= 4
                            && (points[0] - points[n - 2]).abs() < 0.001
                            && (points[1] - points[n - 1]).abs() < 0.001;

                        collection.add_polyline(SymbolicPolyline::new(
                            express_id,
                            ifc_type.to_string(),
                            points,
                            is_closed,
                            rep_identifier.to_string(),
                        ));
                    }
                }
            }
        }
        IfcType::IfcIndexedPolyCurve => {
            // IfcIndexedPolyCurve: Points (IfcCartesianPointList2D/3D), Segments, SelfIntersect
            if let Some(points_ref) = item.get_ref(0) {
                if let Ok(points_list) = decoder.decode_by_id(points_ref) {
                    if let Some(coord_list_attr) = points_list.get(0) {
                        if let Some(coord_list) = coord_list_attr.as_list() {
                            let mut points: Vec<f32> = Vec::with_capacity(coord_list.len() * 2);
                            for coord in coord_list {
                                if let Some(coords) = coord.as_list() {
                                    let local_x =
                                        coords.first().and_then(|v| v.as_float()).unwrap_or(0.0)
                                            as f32
                                            * unit_scale;
                                    let local_y =
                                        coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0)
                                            as f32
                                            * unit_scale;

                                    // Apply full transform (rotation + translation)
                                    let (wx, wy) = transform.transform_point(local_x, local_y);
                                    let x = wx - rtc_x;
                                    // Negate Y to match section cut coordinate system
                                    let y = -wy + rtc_z;

                                    // Skip invalid coordinates
                                    if x.is_finite() && y.is_finite() {
                                        points.push(x);
                                        points.push(y);
                                    }
                                }
                            }
                            if points.len() >= 4 {
                                let n = points.len();
                                let is_closed = n >= 4
                                    && (points[0] - points[n - 2]).abs() < 0.001
                                    && (points[1] - points[n - 1]).abs() < 0.001;

                                collection.add_polyline(SymbolicPolyline::new(
                                    express_id,
                                    ifc_type.to_string(),
                                    points,
                                    is_closed,
                                    rep_identifier.to_string(),
                                ));
                            }
                        }
                    }
                }
            }
        }
        IfcType::IfcCircle => {
            // IfcCircle: Position (IfcAxis2Placement2D/3D), Radius
            let radius = item.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;

            // Skip invalid, degenerate, or unreasonably large radii
            // Radius > 1000 units is likely erroneous data
            if radius <= 0.0 || !radius.is_finite() || radius > 1000.0 {
                return;
            }

            // Get center from Position (attribute 0)
            let (center_x, center_y) = if let Some(pos_ref) = item.get_ref(0) {
                if let Ok(placement) = decoder.decode_by_id(pos_ref) {
                    // IfcAxis2Placement2D/3D: Location
                    if let Some(loc_ref) = placement.get_ref(0) {
                        if let Ok(loc) = decoder.decode_by_id(loc_ref) {
                            if let Some(coords_attr) = loc.get(0) {
                                if let Some(coords) = coords_attr.as_list() {
                                    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0)
                                        as f32
                                        * unit_scale;
                                    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0)
                                        as f32
                                        * unit_scale;
                                    (x, y)
                                } else {
                                    (0.0, 0.0)
                                }
                            } else {
                                (0.0, 0.0)
                            }
                        } else {
                            (0.0, 0.0)
                        }
                    } else {
                        (0.0, 0.0)
                    }
                } else {
                    (0.0, 0.0)
                }
            } else {
                (0.0, 0.0)
            };

            // Validate center coordinates
            if !center_x.is_finite() || !center_y.is_finite() {
                return;
            }

            // Apply full transform (rotation + translation)
            let (wx, wy) = transform.transform_point(center_x, center_y);
            let world_cx = wx - rtc_x;
            // Negate Y to match section cut coordinate system
            let world_cy = -wy + rtc_z;

            collection.add_circle(SymbolicCircle::full_circle(
                express_id,
                ifc_type.to_string(),
                world_cx,
                world_cy,
                radius,
                rep_identifier.to_string(),
            ));
        }
        IfcType::IfcTrimmedCurve => {
            // IfcTrimmedCurve: BasisCurve, Trim1, Trim2, SenseAgreement, MasterRepresentation
            // For arcs, the basis curve is often IfcCircle
            if let Some(basis_ref) = item.get_ref(0) {
                if let Ok(basis_curve) = decoder.decode_by_id(basis_ref) {
                    if basis_curve.ifc_type == IfcType::IfcCircle {
                        // For simplicity, extract as polyline approximation of the arc
                        // Get radius and center
                        let radius = basis_curve.get(1).and_then(|a| a.as_float()).unwrap_or(0.0)
                            as f32
                            * unit_scale;

                        // Skip invalid or degenerate radii
                        if radius <= 0.0 || !radius.is_finite() {
                            return;
                        }

                        let (center_x, center_y) = if let Some(pos_ref) = basis_curve.get_ref(0) {
                            if let Ok(placement) = decoder.decode_by_id(pos_ref) {
                                if let Some(loc_ref) = placement.get_ref(0) {
                                    if let Ok(loc) = decoder.decode_by_id(loc_ref) {
                                        if let Some(coords_attr) = loc.get(0) {
                                            if let Some(coords) = coords_attr.as_list() {
                                                let x = coords
                                                    .first()
                                                    .and_then(|v| v.as_float())
                                                    .unwrap_or(0.0)
                                                    as f32
                                                    * unit_scale;
                                                let y = coords
                                                    .get(1)
                                                    .and_then(|v| v.as_float())
                                                    .unwrap_or(0.0)
                                                    as f32
                                                    * unit_scale;
                                                (x, y)
                                            } else {
                                                (0.0, 0.0)
                                            }
                                        } else {
                                            (0.0, 0.0)
                                        }
                                    } else {
                                        (0.0, 0.0)
                                    }
                                } else {
                                    (0.0, 0.0)
                                }
                            } else {
                                (0.0, 0.0)
                            }
                        } else {
                            (0.0, 0.0)
                        };

                        // Validate center coordinates
                        if !center_x.is_finite() || !center_y.is_finite() {
                            return;
                        }

                        // Get trim parameters (simplified - assume parameter values)
                        let trim1 = item
                            .get(1)
                            .and_then(|a| {
                                a.as_list()
                                    .and_then(|l| l.first().and_then(|v| v.as_float()))
                            })
                            .unwrap_or(0.0) as f32;
                        let trim2 = item
                            .get(2)
                            .and_then(|a| {
                                a.as_list()
                                    .and_then(|l| l.first().and_then(|v| v.as_float()))
                            })
                            .unwrap_or(std::f32::consts::TAU as f64)
                            as f32;

                        // Convert to arc and tessellate as polyline
                        let start_angle = trim1.to_radians().min(trim2.to_radians());
                        let end_angle = trim1.to_radians().max(trim2.to_radians());

                        // Validate angles
                        if !start_angle.is_finite() || !end_angle.is_finite() {
                            return;
                        }

                        // Calculate start and end points for near-collinear detection
                        let start_x = center_x + radius * start_angle.cos();
                        let start_y = center_y + radius * start_angle.sin();
                        let end_x = center_x + radius * end_angle.cos();
                        let end_y = center_y + radius * end_angle.sin();

                        // Calculate chord length
                        let chord_dx = end_x - start_x;
                        let chord_dy = end_y - start_y;
                        let chord_len = (chord_dx * chord_dx + chord_dy * chord_dy).sqrt();

                        // Near-collinear arc detection (from fix-geometry-processing branch):
                        // 1. If radius is extremely large (> 100 units), this is nearly straight
                        // 2. If sagitta (arc height) < 2% of chord length, nearly straight
                        // 3. If radius > 10x chord length, nearly straight
                        let is_near_collinear = if chord_len > 0.0001 {
                            // Calculate sagitta (perpendicular distance from midpoint to chord)
                            let mid_angle = (start_angle + end_angle) / 2.0;
                            let mid_x = center_x + radius * mid_angle.cos();
                            let mid_y = center_y + radius * mid_angle.sin();

                            // Distance from midpoint to chord line
                            let sagitta = ((end_y - start_y) * mid_x - (end_x - start_x) * mid_y
                                + end_x * start_y
                                - end_y * start_x)
                                .abs()
                                / chord_len;

                            radius > 100.0
                                || sagitta < chord_len * 0.02
                                || radius > chord_len * 10.0
                        } else {
                            true // Very short arc, treat as point/line
                        };

                        if is_near_collinear {
                            // Emit as simple line segment instead of tessellated arc
                            let (wsx, wsy) = transform.transform_point(start_x, start_y);
                            let (wex, wey) = transform.transform_point(end_x, end_y);
                            // Negate Y to match section cut coordinate system
                            let points = vec![wsx - rtc_x, -wsy + rtc_z, wex - rtc_x, -wey + rtc_z];
                            collection.add_polyline(SymbolicPolyline::new(
                                express_id,
                                ifc_type.to_string(),
                                points,
                                false,
                                rep_identifier.to_string(),
                            ));
                        } else {
                            // Normal arc tessellation
                            let arc_length = (end_angle - start_angle).abs();
                            let num_segments =
                                ((arc_length * radius / 0.1) as usize).max(8).min(64);

                            let mut points = Vec::with_capacity((num_segments + 1) * 2);
                            for i in 0..=num_segments {
                                let t = i as f32 / num_segments as f32;
                                let angle = start_angle + t * (end_angle - start_angle);
                                let local_x = center_x + radius * angle.cos();
                                let local_y = center_y + radius * angle.sin();

                                // Apply full transform (rotation + translation)
                                let (wx, wy) = transform.transform_point(local_x, local_y);
                                let x = wx - rtc_x;
                                // Negate Y to match section cut coordinate system
                                let y = -wy + rtc_z;

                                // Skip NaN/Infinity points
                                if x.is_finite() && y.is_finite() {
                                    points.push(x);
                                    points.push(y);
                                }
                            }

                            // Only add if we have valid points
                            if points.len() >= 4 {
                                collection.add_polyline(SymbolicPolyline::new(
                                    express_id,
                                    ifc_type.to_string(),
                                    points,
                                    false, // Arcs are not closed
                                    rep_identifier.to_string(),
                                ));
                            }
                        }
                    }
                }
            }
        }
        IfcType::IfcCompositeCurve => {
            // IfcCompositeCurve: Segments (LIST of IfcCompositeCurveSegment), SelfIntersect
            if let Some(segments_attr) = item.get(0) {
                if let Ok(segments) = decoder.resolve_ref_list(segments_attr) {
                    for segment in segments {
                        // IfcCompositeCurveSegment: Transition, SameSense, ParentCurve
                        if let Some(curve_ref) = segment.get_ref(2) {
                            if let Ok(parent_curve) = decoder.decode_by_id(curve_ref) {
                                extract_symbolic_item(
                                    &parent_curve,
                                    decoder,
                                    express_id,
                                    ifc_type,
                                    rep_identifier,
                                    unit_scale,
                                    transform,
                                    rtc_x,
                                    rtc_z,
                                    collection,
                                );
                            }
                        }
                    }
                }
            }
        }
        IfcType::IfcLine => {
            // IfcLine: Pnt (IfcCartesianPoint), Dir (IfcVector)
            // Lines are infinite, so we just skip them (or could extract as a segment)
            // For now, skip - symbolic representations usually use polylines
        }
        IfcType::IfcTextLiteral | IfcType::IfcTextLiteralWithExtent => {
            extract_text_literal(
                item,
                decoder,
                express_id,
                ifc_type,
                rep_identifier,
                unit_scale,
                transform,
                rtc_x,
                rtc_z,
                collection,
            );
        }
        IfcType::IfcAnnotationFillArea => {
            extract_annotation_fill_area(
                item,
                decoder,
                express_id,
                ifc_type,
                rep_identifier,
                unit_scale,
                transform,
                rtc_x,
                rtc_z,
                collection,
            );
        }
        _ => {
            // Unknown curve type - skip
        }
    }
}

/// Parse `IfcTextLiteral` / `IfcTextLiteralWithExtent` into a `SymbolicText`.
///
/// Schema (IFC4):
/// - `IfcTextLiteral`            (Literal, Placement, Path)
/// - `IfcTextLiteralWithExtent`  + (Extent, BoxAlignment)
///
/// The literal string is passed through verbatim — the JS-side `@ifc-lite/encoding`
/// package decodes STEP escape sequences (`\X2\…\X0\`, `\X\…`). Placement is an
/// `IfcAxis2Placement2D|3D`; we collapse to 2D and compose with the item's
/// inherited transform. Font height defaults to `1.0 / unit_scale` (so 1 model
/// unit) when the IFC text style chain isn't resolved here — the renderer can
/// override based on its own typography defaults.
#[allow(clippy::too_many_arguments)]
fn extract_text_literal(
    item: &ifc_lite_core::DecodedEntity,
    decoder: &mut ifc_lite_core::EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    collection: &mut crate::zero_copy::SymbolicRepresentationCollection,
) {
    use crate::zero_copy::SymbolicText;

    // attr 0: Literal (IfcPresentableText / string). Pass through verbatim;
    // the JS encoding package decodes STEP escapes on consume.
    let content = match item.get(0).and_then(|a| a.as_string()) {
        Some(s) => s.to_string(),
        None => return, // empty literal — nothing to render
    };

    // attr 1: Placement (IfcAxis2Placement2D | IfcAxis2Placement3D).
    let placement_transform = if let Some(p_ref) = item.get_ref(1) {
        if let Ok(p) = decoder.decode_by_id(p_ref) {
            parse_axis2_placement_2d(&p, decoder, unit_scale)
        } else {
            Transform2D::identity()
        }
    } else {
        Transform2D::identity()
    };
    let composed = compose_transforms(transform, &placement_transform);

    // attr 3: Extent (IfcPlanarExtent) → SizeInY is the LAYOUT BOX height of
    // the typeset string (cap_height × line_height × line_count), NOT the
    // glyph cap height. Per IFC4 spec IfcTextStyleFontModel.FontSize would
    // give cap height directly, but this fixture (and most floor-plan
    // exporters) ship no IfcTextStyle chain — only Extent. So we convert:
    //
    //   cap_height ≈ SizeInY × CAP_TO_BOX_RATIO
    //
    // 0.7 matches Arial / Helvetica / SimSun (CJK) at line-height 1.0; for
    // multi-line literals the JS layer splits on `\n` first and renders one
    // line per text instance, so this single-line ratio is the right unit.
    //
    // Fallback when SizeInY is absent OR the text is bare IfcTextLiteral
    // (no extent at all): 0.18 m world ≈ 7 mm at 1:50 plot scale, the
    // industry default for annotation text. unit_scale is "meters per file
    // unit" so dividing it in is wrong (it makes mm-files produce 250 m
    // text); keep the fallback in meters directly.
    const CAP_TO_BOX_RATIO: f32 = 0.7;
    const FALLBACK_CAP_HEIGHT_M: f32 = 0.18;
    let height_model_units = if item.ifc_type == ifc_lite_core::IfcType::IfcTextLiteralWithExtent {
        item.get_ref(3)
            .and_then(|extent_ref| decoder.decode_by_id(extent_ref).ok())
            .and_then(|extent| extent.get(1).and_then(|a| a.as_float()))
            .map(|h| (h as f32) * CAP_TO_BOX_RATIO)
            .unwrap_or(FALLBACK_CAP_HEIGHT_M / unit_scale.max(1e-6))
    } else {
        FALLBACK_CAP_HEIGHT_M / unit_scale.max(1e-6)
    };

    // attr 4: BoxAlignment (string enum). Empty when absent.
    let alignment = if item.ifc_type == ifc_lite_core::IfcType::IfcTextLiteralWithExtent {
        item.get(4)
            .and_then(|a| a.as_string())
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };

    // Anchor point is the placement origin after transform composition.
    // Negate Y to match the rest of the section-overlay coordinate system
    // (see polyline/circle paths above).
    let (wx, wy) = composed.transform_point(0.0, 0.0);

    collection.add_text(SymbolicText::new(
        express_id,
        ifc_type.to_string(),
        wx - rtc_x,
        -wy + rtc_z,
        composed.cos_theta,
        -composed.sin_theta, // mirror to match Y-negated coord system
        height_model_units * unit_scale,
        content,
        alignment,
        rep_identifier.to_string(),
    ));
}

/// Parse `IfcAnnotationFillArea` (outer boundary + optional inner holes) into a
/// `SymbolicFillArea`. The boundary curves are limited to `IfcPolyline` and
/// `IfcIndexedPolyCurve` — the two forms used in practice for filled regions.
/// More exotic curves (composite, BSpline) get skipped silently.
///
/// Style resolution (IfcStyledItem → IfcPresentationStyleAssignment →
/// IfcFillAreaStyle → IfcFillAreaStyleHatching) is deferred to a follow-up:
/// the first pass renders a default opaque black solid fill. The JS layer can
/// override that based on per-IFC-type defaults in the meantime.
#[allow(clippy::too_many_arguments)]
fn extract_annotation_fill_area(
    item: &ifc_lite_core::DecodedEntity,
    decoder: &mut ifc_lite_core::EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    collection: &mut crate::zero_copy::SymbolicRepresentationCollection,
) {
    use crate::zero_copy::SymbolicFillArea;

    // Extract one ring of (x, y) points from any supported IfcCurve. Empty
    // vec on unsupported types or parse failure.
    let extract_curve_ring = |curve_id: u32,
                              decoder: &mut ifc_lite_core::EntityDecoder,
                              transform: &Transform2D|
     -> Vec<f32> {
        let Ok(curve) = decoder.decode_by_id(curve_id) else {
            return Vec::new();
        };
        match curve.ifc_type {
            ifc_lite_core::IfcType::IfcPolyline => {
                let Some(points_attr) = curve.get(0) else {
                    return Vec::new();
                };
                let Ok(point_entities) = decoder.resolve_ref_list(points_attr) else {
                    return Vec::new();
                };
                let mut out = Vec::with_capacity(point_entities.len() * 2);
                for pe in point_entities {
                    if pe.ifc_type != ifc_lite_core::IfcType::IfcCartesianPoint {
                        continue;
                    }
                    let Some(coords_attr) = pe.get(0) else { continue };
                    let Some(coords) = coords_attr.as_list() else { continue };
                    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32
                        * unit_scale;
                    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32
                        * unit_scale;
                    let (wx, wy) = transform.transform_point(x, y);
                    out.push(wx - rtc_x);
                    out.push(-wy + rtc_z);
                }
                out
            }
            ifc_lite_core::IfcType::IfcIndexedPolyCurve => {
                // attr 0: Points (IfcCartesianPointList2D | 3D)
                let Some(points_ref) = curve.get_ref(0) else {
                    return Vec::new();
                };
                let Ok(points_entity) = decoder.decode_by_id(points_ref) else {
                    return Vec::new();
                };
                // IfcCartesianPointList2D.CoordList is a list-of-list of REALs.
                let Some(coord_list_attr) = points_entity.get(0) else {
                    return Vec::new();
                };
                let Some(coord_list) = coord_list_attr.as_list() else {
                    return Vec::new();
                };
                let mut out = Vec::with_capacity(coord_list.len() * 2);
                for tuple in coord_list {
                    let Some(coords) = tuple.as_list() else { continue };
                    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32
                        * unit_scale;
                    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32
                        * unit_scale;
                    let (wx, wy) = transform.transform_point(x, y);
                    out.push(wx - rtc_x);
                    out.push(-wy + rtc_z);
                }
                out
            }
            ifc_lite_core::IfcType::IfcCircle => {
                // IfcAnnotationFillArea with a circle boundary = filled disk.
                // The IFC_Annotation fixture uses this pattern for every
                // leader-dot bubble (120 instances, radius 10 mm, black
                // SolidBlackFill). Tessellate the boundary to a polygon so
                // the existing ear-clip triangulator can fill it.
                let radius = curve.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32
                    * unit_scale;
                if radius <= 0.0 || !radius.is_finite() {
                    return Vec::new();
                }
                // Center via IfcAxis2Placement.Location (matches the standalone
                // IfcCircle path at symbolic.rs:789). Walk via mutable bindings
                // because `Option::cloned()` doesn't work on `Option<&[T]>` and
                // the decoded entities can't outlive the decoder borrow.
                let mut cx_local: f32 = 0.0;
                let mut cy_local: f32 = 0.0;
                if let Some(pos_ref) = curve.get_ref(0) {
                    if let Ok(placement) = decoder.decode_by_id(pos_ref) {
                        if let Some(loc_ref) = placement.get_ref(0) {
                            if let Ok(loc) = decoder.decode_by_id(loc_ref) {
                                if let Some(coords) = loc.get(0).and_then(|a| a.as_list()) {
                                    cx_local = coords.first().and_then(|v| v.as_float())
                                        .unwrap_or(0.0) as f32
                                        * unit_scale;
                                    cy_local = coords.get(1).and_then(|v| v.as_float())
                                        .unwrap_or(0.0) as f32
                                        * unit_scale;
                                }
                            }
                        }
                    }
                }

                // Segment count: bigger circles get more segments. Cap at 64
                // (matches IFC_Model.ifc curve-tessellation budget). For the
                // 10 mm bubbles in this fixture, 32 segments is more than
                // enough to look perfectly round at any reasonable zoom.
                let seg_count = if radius < 0.05 { 32 } else { 64 };
                let mut out = Vec::with_capacity((seg_count + 1) * 2);
                // CCW winding so the ear-clip triangulator produces front-
                // facing fills (the existing IfcPolyline path assumes CCW).
                let two_pi = std::f32::consts::TAU;
                for i in 0..seg_count {
                    let theta = (i as f32) * two_pi / (seg_count as f32);
                    let lx = cx_local + radius * theta.cos();
                    let ly = cy_local + radius * theta.sin();
                    let (wx, wy) = transform.transform_point(lx, ly);
                    out.push(wx - rtc_x);
                    out.push(-wy + rtc_z);
                }
                out
            }
            _ => Vec::new(),
        }
    };

    // attr 0: OuterBoundary (IfcCurve, required)
    let Some(outer_ref) = item.get_ref(0) else { return };
    let mut points = extract_curve_ring(outer_ref, decoder, transform);
    if points.len() < 6 {
        // Need at least 3 vertices to form a fillable polygon.
        return;
    }

    // attr 1: InnerBoundaries (SET OF IfcCurve, optional) — holes.
    let mut holes_offsets: Vec<u32> = Vec::new();
    if let Some(inners_attr) = item.get(1) {
        if let Ok(inner_list) = decoder.resolve_ref_list(inners_attr) {
            for inner in inner_list {
                let hole = extract_curve_ring(inner.id, decoder, transform);
                if hole.len() >= 6 {
                    let vertex_index = (points.len() / 2) as u32;
                    holes_offsets.push(vertex_index);
                    points.extend(hole);
                }
            }
        }
    }

    collection.add_fill(SymbolicFillArea::new(
        express_id,
        ifc_type.to_string(),
        points,
        holes_offsets,
        // Default fill: opaque dark grey (75% black). The JS renderer reads
        // SymbolicFillArea.fillR/G/B/A and can substitute a per-type palette;
        // the IfcStyledItem chain that derives the real style lives in a
        // follow-up commit.
        [0.0, 0.0, 0.0, 0.75],
        rep_identifier.to_string(),
    ));
}
