// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Profile extraction for architectural 2D drawing projection.
//!
//! Extracts raw profile polygons from IfcExtrudedAreaSolid building elements,
//! enabling clean 2D projection without tessellation artifacts from EdgeExtractor.
//!
//! # Coverage
//! - `IfcExtrudedAreaSolid` with any profile type (rectangle, circle, arbitrary)
//! - `IfcMappedItem` — recurses into representation maps with composed transforms
//! - Full element placement chain (IfcLocalPlacement hierarchy)
//! - Direct and nested representations
//!
//! # Coordinate system
//! All output is in WebGL Y-up space (IFC Z-up converted: new_y = old_z, new_z = -old_y).
//! Lengths are in metres (unit scale applied).

use crate::profiles::ProfileProcessor;
use crate::{Error, Point3, Result, Vector3};
use ifc_lite_core::{
    build_entity_index, AttributeValue, DecodedEntity, EntityDecoder, EntityScanner, IfcSchema,
    IfcType,
};
use nalgebra::Matrix4;

/// Whether `t` is `IfcExtrudedAreaSolid` or its `IfcExtrudedAreaSolidTapered`
/// subtype. Both share attributes 0..3 so the same extraction path works.
#[inline]
fn is_extruded_area_solid(t: IfcType) -> bool {
    matches!(
        t,
        IfcType::IfcExtrudedAreaSolid | IfcType::IfcExtrudedAreaSolidTapered
    )
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════════

/// A profile extracted from a single IFC building element.
///
/// All geometry is in **WebGL Y-up world space** (metres).
/// Applying `transform` to a local 2D point `[x, y, 0, 1]` gives the
/// world-space 3D position.
#[derive(Debug, Clone)]
pub struct ExtractedProfile {
    /// Express ID of the building element.
    pub express_id: u32,
    /// IFC type name (e.g., `"IfcWall"`).
    pub ifc_type: String,
    /// Outer boundary: interleaved `[x0, y0, x1, y1, …]` in local profile space (metres).
    pub outer_points: Vec<f32>,
    /// Number of points in each hole (one entry per hole).
    pub hole_counts: Vec<u32>,
    /// All hole points concatenated: `[x0, y0, x1, y1, …]` in local profile space (metres).
    pub hole_points: Vec<f32>,
    /// 4 × 4 column-major transform **in WebGL Y-up world space**.
    /// `M * [x_2d, y_2d, 0, 1]ᵀ` → world position.
    pub transform: [f32; 16],
    /// Extrusion direction in WebGL Y-up world space (unit vector).
    pub extrusion_dir: [f32; 3],
    /// Extrusion depth in metres.
    pub extrusion_depth: f32,
    /// Model index (for multi-model federation).
    pub model_index: u32,
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

/// Extract profiles for every building element in `content`.
///
/// Extracts `IfcExtrudedAreaSolid` representations, including those nested
/// inside `IfcMappedItem` chains (up to 3 levels deep).
/// Returns an empty `Vec` for models with no such elements.
pub fn extract_profiles(content: &str, model_index: u32) -> Vec<ExtractedProfile> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // Detect unit scale (same approach as GeometryRouter::with_units)
    let unit_scale = detect_unit_scale(content, &mut decoder);

    let schema = IfcSchema::new();
    let profile_processor = ProfileProcessor::new(schema);

    let mut results = Vec::new();
    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::has_geometry_by_name(type_name) {
            continue;
        }

        let entity = match decoder.decode_at_with_id(id, start, end) {
            Ok(e) => e,
            Err(_) => continue,
        };

        // ObjectPlacement (attr 5) → element world transform (IFC Z-up, native units)
        let element_transform = get_placement_transform(entity.get(5), &mut decoder);

        // Scale the translation part from file units to metres
        let elem_tf = scale_translation(element_transform, unit_scale);

        // Representation (attr 6) → IfcProductDefinitionShape
        let repr_attr = match entity.get(6) {
            Some(a) if !a.is_null() => a,
            _ => continue,
        };
        let repr = match decoder.resolve_ref(repr_attr) {
            Ok(Some(r)) => r,
            _ => continue,
        };

        // IfcProductDefinitionShape → Representations (attr 2)
        let reprs_attr = match repr.get(2) {
            Some(a) => a,
            None => continue,
        };
        let representations = match decoder.resolve_ref_list(reprs_attr) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let ifc_type_name = entity.ifc_type.name().to_string();

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            // Accept Body and SweptSolid representations
            let rep_id = shape_rep.get(1).and_then(|a| a.as_string()).unwrap_or("");
            if rep_id != "Body" && rep_id != "SweptSolid" {
                continue;
            }

            // Items (attr 3)
            let items_attr = match shape_rep.get(3) {
                Some(a) => a,
                None => continue,
            };
            let items = match decoder.resolve_ref_list(items_attr) {
                Ok(i) => i,
                Err(_) => continue,
            };

            for item in &items {
                if is_extruded_area_solid(item.ifc_type) {
                    match extract_extruded_solid(
                        id,
                        &ifc_type_name,
                        item,
                        &elem_tf,
                        unit_scale,
                        &profile_processor,
                        &mut decoder,
                        model_index,
                    ) {
                        Ok(entry) => results.push(entry),
                        Err(_e) => {
                            #[cfg(feature = "debug_geometry")]
                            eprintln!("[profile_extractor] Skipping #{id} ({ifc_type_name}): {_e}");
                        }
                    }
                } else if item.ifc_type == IfcType::IfcMappedItem {
                    extract_mapped_item_profiles(
                        id,
                        &ifc_type_name,
                        item,
                        &elem_tf,
                        unit_scale,
                        &profile_processor,
                        &mut decoder,
                        model_index,
                        0,
                        &mut results,
                    );
                }
            }
        }
    }

    results
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE: MAPPED ITEM EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

/// Maximum recursion depth for nested IfcMappedItem chains.
const MAX_MAPPED_DEPTH: usize = 3;

/// Recursively extract profiles from an IfcMappedItem.
///
/// IfcMappedItem structure:
///   attr 0: MappingSource → IfcRepresentationMap
///     attr 0: MappingOrigin (IfcAxis2Placement) — local coordinate system of shared geometry
///     attr 1: MappedRepresentation (IfcRepresentation) → items to extract from
///   attr 1: MappingTarget → IfcCartesianTransformationOperator3D (instance transform)
///
/// The composed transform is: `elem_transform * mapping_target`.
/// Each solid's own Position is applied inside `extract_extruded_solid`.
fn extract_mapped_item_profiles(
    element_id: u32,
    ifc_type: &str,
    mapped_item: &DecodedEntity,
    elem_transform: &Matrix4<f64>,
    unit_scale: f64,
    profile_processor: &ProfileProcessor,
    decoder: &mut EntityDecoder,
    model_index: u32,
    depth: usize,
    results: &mut Vec<ExtractedProfile>,
) {
    if depth > MAX_MAPPED_DEPTH {
        #[cfg(feature = "debug_geometry")]
        eprintln!("[profile_extractor] #{element_id} ({ifc_type}): max mapped item depth exceeded");
        return;
    }

    // Attr 0: MappingSource → IfcRepresentationMap
    let source = match mapped_item
        .get(0)
        .and_then(|a| if a.is_null() { None } else { Some(a) })
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
    {
        Some(s) => s,
        None => return,
    };

    // Attr 1: MappingTarget → IfcCartesianTransformationOperator3D
    let target_tf = mapped_item
        .get(1)
        .and_then(|a| if a.is_null() { None } else { Some(a) })
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
        .and_then(|e| parse_cartesian_transformation_operator(&e, decoder).ok())
        .unwrap_or_else(Matrix4::identity);

    // Scale the target transform translation from file units to metres
    let scaled_target = scale_translation(target_tf, unit_scale);
    let composed = elem_transform * scaled_target;

    // MappedRepresentation (attr 1 of RepresentationMap) → items
    let mapped_rep = match source
        .get(1)
        .and_then(|a| if a.is_null() { None } else { Some(a) })
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
    {
        Some(r) => r,
        None => return,
    };

    let items = match mapped_rep
        .get(3)
        .and_then(|a| decoder.resolve_ref_list(a).ok())
    {
        Some(i) => i,
        None => return,
    };

    for sub_item in &items {
        if is_extruded_area_solid(sub_item.ifc_type) {
            match extract_extruded_solid(
                element_id,
                ifc_type,
                sub_item,
                &composed,
                unit_scale,
                profile_processor,
                decoder,
                model_index,
            ) {
                Ok(entry) => results.push(entry),
                Err(_e) => {
                    #[cfg(feature = "debug_geometry")]
                    eprintln!("[profile_extractor] #{element_id} ({ifc_type}) mapped: {_e}");
                }
            }
        } else if sub_item.ifc_type == IfcType::IfcMappedItem {
            extract_mapped_item_profiles(
                element_id,
                ifc_type,
                sub_item,
                &composed,
                unit_scale,
                profile_processor,
                decoder,
                model_index,
                depth + 1,
                results,
            );
        }
    }
}

/// Parse IfcCartesianTransformationOperator3D into a Matrix4<f64>.
///
/// Attributes:
///   0: Axis1 (X direction, optional)
///   1: Axis2 (Y direction, optional)
///   2: LocalOrigin (IfcCartesianPoint)
///   3: Scale (f64, default 1.0)
///   4: Axis3 (Z direction, optional, 3D only)
fn parse_cartesian_transformation_operator(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    // LocalOrigin (attr 2)
    let origin = parse_cartesian_point(entity, decoder, 2).unwrap_or(Point3::new(0.0, 0.0, 0.0));

    // Scale (attr 3)
    let scale = entity.get(3).and_then(|v| v.as_float()).unwrap_or(1.0);

    // Axis1 / X direction (attr 0)
    let x_axis = entity
        .get(0)
        .filter(|a| !a.is_null())
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
        .and_then(|e| parse_direction_entity(&e).ok())
        .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0))
        .normalize();

    // Axis3 / Z direction (attr 4, 3D only)
    let z_axis = entity
        .get(4)
        .filter(|a| !a.is_null())
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
        .and_then(|e| parse_direction_entity(&e).ok())
        .unwrap_or_else(|| Vector3::new(0.0, 0.0, 1.0))
        .normalize();

    // Derive orthogonal axes (right-hand system)
    let y_axis = z_axis.cross(&x_axis).normalize();
    let x_axis = y_axis.cross(&z_axis).normalize();

    #[rustfmt::skip]
    let m = Matrix4::new(
        x_axis.x * scale, y_axis.x * scale, z_axis.x * scale, origin.x,
        x_axis.y * scale, y_axis.y * scale, z_axis.y * scale, origin.y,
        x_axis.z * scale, y_axis.z * scale, z_axis.z * scale, origin.z,
        0.0,              0.0,              0.0,              1.0,
    );
    Ok(m)
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE: SOLID EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

fn extract_extruded_solid(
    element_id: u32,
    ifc_type: &str,
    solid: &DecodedEntity,
    elem_transform: &Matrix4<f64>,
    unit_scale: f64,
    profile_processor: &ProfileProcessor,
    decoder: &mut EntityDecoder,
    model_index: u32,
) -> Result<ExtractedProfile> {
    // SweptArea (attr 0)
    let profile_attr = solid
        .get(0)
        .ok_or_else(|| Error::geometry("ExtrudedAreaSolid missing SweptArea"))?;
    let profile_entity = decoder
        .resolve_ref(profile_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve SweptArea"))?;
    let profile = profile_processor.process(&profile_entity, decoder)?;

    if profile.outer.is_empty() {
        return Err(Error::geometry("empty profile"));
    }

    // Position (attr 1) → solid local transform in IFC native units
    let solid_transform = if let Some(pos_attr) = solid.get(1) {
        if !pos_attr.is_null() {
            if let Some(pos_ent) = decoder.resolve_ref(pos_attr)? {
                if pos_ent.ifc_type == IfcType::IfcAxis2Placement3D {
                    let mut t = parse_axis2_placement_3d(&pos_ent, decoder)?;
                    // Scale translation from file units to metres
                    t[(0, 3)] *= unit_scale;
                    t[(1, 3)] *= unit_scale;
                    t[(2, 3)] *= unit_scale;
                    t
                } else {
                    Matrix4::identity()
                }
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        }
    } else {
        Matrix4::identity()
    };

    // ExtrudedDirection (attr 2) in local solid space
    let local_dir = parse_extrusion_direction(solid, decoder);

    // Depth (attr 3) — required per IFC spec but default to 1.0 for robustness
    // with malformed files (logged under debug_geometry feature)
    let raw_depth = solid.get(3).and_then(|v| v.as_float());
    #[cfg(feature = "debug_geometry")]
    if raw_depth.is_none() {
        eprintln!(
            "[profile_extractor] #{element_id} ({ifc_type}): missing Depth, defaulting to 1.0"
        );
    }
    let depth = raw_depth.unwrap_or(1.0) * unit_scale;

    // Combined transform: elem_placement * solid_position  (IFC Z-up, metres)
    let combined_ifc = elem_transform * solid_transform;

    // Convert combined transform to WebGL Y-up column-major [f32; 16]
    let transform = convert_ifc_to_webgl(&combined_ifc);

    // Transform local extrusion direction to world IFC space (rotation only, no translation)
    let world_dir_ifc = combined_ifc.transform_vector(&local_dir);

    // Convert world direction to WebGL Y-up
    let extrusion_dir = [
        world_dir_ifc.x as f32,
        world_dir_ifc.z as f32,  // WebGL Y = IFC Z
        -world_dir_ifc.y as f32, // WebGL Z = -IFC Y
    ];

    // Scale profile 2D points from file units to metres
    let outer_points: Vec<f32> = profile
        .outer
        .iter()
        .flat_map(|p| [(p.x * unit_scale) as f32, (p.y * unit_scale) as f32])
        .collect();

    let hole_counts: Vec<u32> = profile.holes.iter().map(|h| h.len() as u32).collect();
    let hole_points: Vec<f32> = profile
        .holes
        .iter()
        .flat_map(|h| {
            h.iter()
                .flat_map(|p| [(p.x * unit_scale) as f32, (p.y * unit_scale) as f32])
        })
        .collect();

    Ok(ExtractedProfile {
        express_id: element_id,
        ifc_type: ifc_type.to_string(),
        outer_points,
        hole_counts,
        hole_points,
        transform,
        extrusion_dir,
        extrusion_depth: depth as f32,
        model_index,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE: PLACEMENT TRAVERSAL
// Duplicated from router/transforms.rs (pub(super) there) to avoid coupling.
// ═══════════════════════════════════════════════════════════════════════════

/// Resolve an element's ObjectPlacement attribute to a world Matrix4 in IFC Z-up space.
fn get_placement_transform(
    placement_attr: Option<&AttributeValue>,
    decoder: &mut EntityDecoder,
) -> Matrix4<f64> {
    let attr = match placement_attr {
        Some(a) if !a.is_null() => a,
        _ => return Matrix4::identity(),
    };
    match decoder.resolve_ref(attr) {
        Ok(Some(p)) => get_placement_recursive(&p, decoder, 0),
        _ => Matrix4::identity(),
    }
}

const MAX_PLACEMENT_DEPTH: usize = 100;

fn get_placement_recursive(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
    depth: usize,
) -> Matrix4<f64> {
    if depth > MAX_PLACEMENT_DEPTH || placement.ifc_type != IfcType::IfcLocalPlacement {
        return Matrix4::identity();
    }

    // PlacementRelTo (attr 0) → parent transform
    let parent_tf = if let Some(parent_attr) = placement.get(0) {
        if !parent_attr.is_null() {
            match decoder.resolve_ref(parent_attr) {
                Ok(Some(parent)) => get_placement_recursive(&parent, decoder, depth + 1),
                _ => Matrix4::identity(),
            }
        } else {
            Matrix4::identity()
        }
    } else {
        Matrix4::identity()
    };

    // RelativePlacement (attr 1) → local axis placement
    let local_tf = if let Some(rel_attr) = placement.get(1) {
        if !rel_attr.is_null() {
            match decoder.resolve_ref(rel_attr) {
                Ok(Some(rel)) if rel.ifc_type == IfcType::IfcAxis2Placement3D => {
                    parse_axis2_placement_3d(&rel, decoder).unwrap_or(Matrix4::identity())
                }
                _ => Matrix4::identity(),
            }
        } else {
            Matrix4::identity()
        }
    } else {
        Matrix4::identity()
    };

    parent_tf * local_tf
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE: IFC ENTITY PARSERS
// Duplicated from processors/helpers.rs (pub(super) there).
// ═══════════════════════════════════════════════════════════════════════════

/// Parse IfcAxis2Placement3D → Matrix4<f64> in IFC Z-up space (native units).
fn parse_axis2_placement_3d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    // Location (attr 0)
    let location =
        parse_cartesian_point(placement, decoder, 0).unwrap_or(Point3::new(0.0, 0.0, 0.0));

    // Axis/Z direction (attr 1)
    let z_axis = if let Some(a) = placement.get(1) {
        if !a.is_null() {
            decoder
                .resolve_ref(a)?
                .map(|e| parse_direction_entity(&e))
                .transpose()?
                .unwrap_or(Vector3::new(0.0, 0.0, 1.0))
        } else {
            Vector3::new(0.0, 0.0, 1.0)
        }
    } else {
        Vector3::new(0.0, 0.0, 1.0)
    };

    // RefDirection/X (attr 2)
    let x_axis_raw = if let Some(a) = placement.get(2) {
        if !a.is_null() {
            decoder
                .resolve_ref(a)?
                .map(|e| parse_direction_entity(&e))
                .transpose()?
                .unwrap_or(Vector3::new(1.0, 0.0, 0.0))
        } else {
            Vector3::new(1.0, 0.0, 0.0)
        }
    } else {
        Vector3::new(1.0, 0.0, 0.0)
    };

    let z = z_axis.normalize();

    // Gram–Schmidt: ensure X is orthogonal to Z
    let dot = x_axis_raw.dot(&z);
    let x_orth = x_axis_raw - z * dot;
    let x = if x_orth.norm() > 1e-6 {
        x_orth.normalize()
    } else {
        // Fallback if X and Z are nearly parallel
        if z.z.abs() < 0.9 {
            Vector3::new(0.0, 0.0, 1.0).cross(&z).normalize()
        } else {
            Vector3::new(1.0, 0.0, 0.0).cross(&z).normalize()
        }
    };
    let y = z.cross(&x).normalize();

    // Column-major construction: columns = [x | y | z | loc]
    #[rustfmt::skip]
    let m = Matrix4::new(
        x.x, y.x, z.x, location.x,
        x.y, y.y, z.y, location.y,
        x.z, y.z, z.z, location.z,
        0.0, 0.0, 0.0, 1.0,
    );
    Ok(m)
}

/// Parse IfcCartesianPoint from a parent entity at the given attribute index.
fn parse_cartesian_point(
    parent: &DecodedEntity,
    decoder: &mut EntityDecoder,
    attr_index: usize,
) -> Result<Point3<f64>> {
    let pt_attr = parent
        .get(attr_index)
        .ok_or_else(|| Error::geometry("Missing cartesian point attr"))?;

    if pt_attr.is_null() {
        return Ok(Point3::new(0.0, 0.0, 0.0));
    }

    let pt_entity = decoder
        .resolve_ref(pt_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve IfcCartesianPoint"))?;

    let coords = pt_entity
        .get(0)
        .and_then(|a| a.as_list())
        .ok_or_else(|| Error::geometry("IfcCartesianPoint missing coordinates"))?;

    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);

    Ok(Point3::new(x, y, z))
}

/// Parse IfcDirection entity to a Vector3.
fn parse_direction_entity(entity: &DecodedEntity) -> Result<Vector3<f64>> {
    let ratios = entity
        .get(0)
        .and_then(|a| a.as_list())
        .ok_or_else(|| Error::geometry("IfcDirection missing ratios"))?;

    let x = ratios.first().and_then(|v| v.as_float()).unwrap_or(0.0);
    let y = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
    let z = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(1.0);

    Ok(Vector3::new(x, y, z).normalize())
}

/// Parse IfcExtrudedAreaSolid ExtrudedDirection (attr 2) to a local Vector3.
fn parse_extrusion_direction(solid: &DecodedEntity, decoder: &mut EntityDecoder) -> Vector3<f64> {
    let default = Vector3::new(0.0, 0.0, 1.0);
    let dir_attr = match solid.get(2) {
        Some(a) if !a.is_null() => a,
        _ => return default,
    };
    let dir_ent = match decoder.resolve_ref(dir_attr) {
        Ok(Some(e)) => e,
        _ => return default,
    };
    let ratios = match dir_ent.get(0).and_then(|a| a.as_list()) {
        Some(r) => r,
        None => return default,
    };
    let x = ratios.first().and_then(|v| v.as_float()).unwrap_or(0.0);
    let y = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
    let z = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(1.0);
    let v = Vector3::new(x, y, z);
    let len = v.norm();
    if len > 1e-10 {
        v / len
    } else {
        default
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE: COORDINATE CONVERSION & UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/// Scale only the translation column of a matrix (rows 0-2 of column 3).
fn scale_translation(mut m: Matrix4<f64>, scale: f64) -> Matrix4<f64> {
    if scale != 1.0 {
        m[(0, 3)] *= scale;
        m[(1, 3)] *= scale;
        m[(2, 3)] *= scale;
    }
    m
}

/// Convert an IFC Z-up Matrix4 to WebGL Y-up column-major [f32; 16].
///
/// Conversion: new_y = old_z, new_z = -old_y (swap Y/Z, negate new Z).
/// Applied row-wise: row 0 stays, row 1 ← row 2, row 2 ← −row 1.
fn convert_ifc_to_webgl(m: &Matrix4<f64>) -> [f32; 16] {
    let mut result = [0.0f32; 16];
    for col in 0..4 {
        result[col * 4 + 0] = m[(0, col)] as f32; // X row: unchanged
        result[col * 4 + 1] = m[(2, col)] as f32; // Y row: was Z
        result[col * 4 + 2] = -m[(1, col)] as f32; // Z row: was -Y
        result[col * 4 + 3] = m[(3, col)] as f32; // homogeneous
    }
    result
}

/// Detect the IFC length unit scale factor from IFCPROJECT.
fn detect_unit_scale(content: &str, decoder: &mut EntityDecoder) -> f64 {
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, _, _)) = scanner.next_entity() {
        if type_name == "IFCPROJECT" {
            if let Ok(scale) = ifc_lite_core::extract_length_unit_scale(decoder, id) {
                return scale;
            }
            break;
        }
    }
    1.0
}
