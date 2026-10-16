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
//! - The element placement, mapping transforms and unit scale the mesh path
//!   uses (`GeometryRouter`), so a drawing and the 3D model agree (PROC-2, #7690)
//! - Direct and nested representations
//!
//! # Coordinate system
//! All output is in WebGL Y-up space (IFC Z-up converted: new_y = old_z, new_z = -old_y).
//! Lengths are in metres (unit scale applied).

use crate::processors::extrusion_params::ExtrusionParams;
use crate::profiles::ProfileProcessor;
use crate::router::GeometryRouter;
use crate::{profile_skip::SkippedProfile, Error, Result, TessellationQuality};
use ifc_lite_core::{
    build_entity_index, DecodedEntity, EntityDecoder, EntityScanner, IfcSchema, IfcType,
};
use nalgebra::Matrix4;

/// Whether `t` should be picked up by the constant-profile 2D drawing
/// extractor.
///
/// `IfcExtrudedAreaSolidTapered` is intentionally **not** included here even
/// though it is a subtype of `IfcExtrudedAreaSolid`: this extractor stores a
/// single outer polygon, and a tapered solid has two distinct cross sections
/// (`SweptArea` and `EndSweptArea`). Treating it as constant would draw the
/// start profile only and silently under-report the element footprint. Until
/// `ExtractedProfile` can carry both profiles (or their union/hull), tapered
/// solids skip this path; their 3D mesh is still rendered by
/// `ExtrudedAreaSolidTaperedProcessor`. Tracked as a follow-up to #628.
#[inline]
fn is_extruded_area_solid(t: IfcType) -> bool {
    matches!(t, IfcType::IfcExtrudedAreaSolid)
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
    ///
    /// f64, because the translation is the element's absolute world position:
    /// at national-grid magnitude (LV95, ~2.6e6 m) an f32 step is 0.25 m, which
    /// moved two spaces authored 4.1 m apart to 4.25 m in the HBJSON/DFJSON
    /// rebase and broke their adjacency (EXPORT-DATA-6, #7684 / #7690).
    pub transform: [f64; 16],
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

/// Extract `IfcExtrudedAreaSolid` profiles (incl. nested `IfcMappedItem`) for every element in `content`. Drops are silent — see [`extract_profiles_with_diagnostics`].
pub fn extract_profiles<T: AsRef<[u8]> + ?Sized>(content: &T, model_index: u32) -> Vec<ExtractedProfile> {
    extract_profiles_with_diagnostics(content, model_index).0
}
/// Same as [`extract_profiles`], plus every [`SkippedProfile`] (default features — unlike `diag_debug!`).
pub fn extract_profiles_with_diagnostics<T: AsRef<[u8]> + ?Sized>(content: &T, model_index: u32) -> (Vec<ExtractedProfile>, Vec<SkippedProfile>) {
    let content = content.as_ref();
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // The mesh path's unit scale, placement walk and mapping transforms, so a
    // drawing can never place an element where the 3D model does not: this file
    // used to carry its own placement walk, which missed IfcLinearPlacement and
    // IfcGridPlacement (PROC-2, #7690).
    let router = GeometryRouter::with_units(content, &mut decoder);
    let unit_scale = router.unit_scale();

    let schema = IfcSchema::new();
    let profile_processor = ProfileProcessor::new(schema);

    let (mut results, mut skipped) = (Vec::new(), Vec::new());
    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::has_geometry_by_name(type_name) {
            continue;
        }

        let entity = match decoder.decode_at_with_id(id, start, end) {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Issue #979: feature elements (IfcOpeningElement and the rest of the
        // void/feature family) are boolean operands, not building structure —
        // they must never emit a construction-projection profile, and walking
        // the supertype chain covers the whole family in one check. Resolved
        // Resolve from `type_name`, not `entity.ifc_type`: only the legacy-aware
        // resolver preserves exact variants. Before support, bare `from_str` produced
        // `Unknown` and `IFCOPENINGSTANDARDCASE` emitted a profile (#3172).
        let resolved_type = ifc_lite_core::ifc_type_from_keyword(type_name);
        if resolved_type.is_subtype_of(IfcType::IfcFeatureElement) {
            continue;
        }

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

        let ifc_type_name = resolved_type.name().to_string();
        // ObjectPlacement (attr 5) → world transform (IFC Z-up, metres), resolved
        // on the first extractable item: an element with no extrusion never needs it.
        let mut elem_tf: Option<Matrix4<f64>> = None;

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
                let extractable = is_extruded_area_solid(item.ifc_type.clone())
                    || item.ifc_type == IfcType::IfcMappedItem;
                if extractable && elem_tf.is_none() {
                    match router.resolve_scaled_placement(&entity, &mut decoder) {
                        Ok(m) => elem_tf = Some(Matrix4::from_column_slice(&m)),
                        Err(e) => {
                            skip(&mut skipped, id, &ifc_type_name, format!("placement: {e}"));
                            break;
                        }
                    }
                }
                let Some(elem_tf) = elem_tf.as_ref() else { continue };
                if is_extruded_area_solid(item.ifc_type.clone()) {
                    match extract_extruded_solid(
                        id,
                        &ifc_type_name,
                        item,
                        elem_tf,
                        unit_scale,
                        &profile_processor,
                        &mut decoder,
                        model_index,
                    ) {
                        Ok(entry) => results.push(entry),
                        Err(_e) => {
                            crate::diag::diag_debug!(
                                { element_id = id, ifc_type = %ifc_type_name, error = %_e,
                                  "profile_extractor: skipping element" }
                                else {
                                    #[cfg(feature = "debug_geometry")]
                                    eprintln!("[profile_extractor] Skipping #{id} ({ifc_type_name}): {_e}");
                                }
                            );
                            skip(&mut skipped, id, &ifc_type_name, _e.to_string());
                        }
                    }
                } else if item.ifc_type == IfcType::IfcMappedItem {
                    extract_mapped_item_profiles(
                        &router,
                        id,
                        &ifc_type_name,
                        item,
                        elem_tf,
                        unit_scale,
                        &profile_processor,
                        &mut decoder,
                        model_index,
                        0,
                        &mut results, &mut skipped,
                    );
                }
            }
        }
    }

    (results, skipped)
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
/// The composed transform is `elem_transform * MappingTarget * MappingOrigin`.
/// Each solid's own Position is applied inside `extract_extruded_solid`.
fn extract_mapped_item_profiles(
    router: &GeometryRouter,
    element_id: u32,
    ifc_type: &str,
    mapped_item: &DecodedEntity,
    elem_transform: &Matrix4<f64>,
    unit_scale: f64,
    profile_processor: &ProfileProcessor,
    decoder: &mut EntityDecoder,
    model_index: u32,
    depth: usize,
    results: &mut Vec<ExtractedProfile>, skipped: &mut Vec<SkippedProfile>,
) {
    if depth > MAX_MAPPED_DEPTH {
        crate::diag::diag_debug!(
            { element_id, ifc_type = %ifc_type, max_depth = MAX_MAPPED_DEPTH,
              "profile_extractor: max mapped item depth exceeded" }
            else {
                #[cfg(feature = "debug_geometry")]
                eprintln!("[profile_extractor] #{element_id} ({ifc_type}): max mapped item depth exceeded");
            }
        );
        skip(skipped, element_id, ifc_type, "max mapped item depth exceeded".to_string());
        return;
    }

    // Every early return below records why: a mapped item the drawing drops
    // must be visible in the diagnostics, as the depth cap always was (PROC-2).
    let mut abandon = |reason: &str| skip(skipped, element_id, ifc_type, format!("mapped item #{}: {reason}", mapped_item.id));

    // Attr 0: MappingSource → IfcRepresentationMap
    let Some(source) = mapped_item
        .get(0)
        .filter(|a| !a.is_null())
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
    else {
        return abandon("MappingSource does not resolve");
    };

    // MappingTarget · MappingOrigin, translation in metres: the mesh path's own
    // composition (#1985), so the drawing and the 3D item cannot disagree about
    // a target, a 2D origin or a broken reference.
    let scaled_target = match router.resolve_scaled_mapped_item_transform(mapped_item, &source, decoder) {
        Ok(Some(m)) => Matrix4::from_column_slice(&m),
        Ok(None) => Matrix4::identity(),
        Err(e) => return abandon(&e.to_string()),
    };
    let composed = elem_transform * scaled_target;

    // MappedRepresentation (attr 1 of RepresentationMap) → items
    let Some(mapped_rep) = source
        .get(1)
        .filter(|a| !a.is_null())
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
    else {
        return abandon("MappedRepresentation does not resolve");
    };
    let Some(items) = mapped_rep.get(3).and_then(|a| decoder.resolve_ref_list(a).ok()) else {
        return abandon("MappedRepresentation items do not resolve");
    };

    for sub_item in &items {
        if is_extruded_area_solid(sub_item.ifc_type.clone()) {
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
                    crate::diag::diag_debug!(
                        { element_id, ifc_type = %ifc_type, error = %_e,
                          "profile_extractor: skipping mapped item solid" }
                        else {
                            #[cfg(feature = "debug_geometry")]
                            eprintln!("[profile_extractor] #{element_id} ({ifc_type}) mapped: {_e}");
                        }
                    );
                    skip(skipped, element_id, ifc_type, _e.to_string());
                }
            }
        } else if sub_item.ifc_type == IfcType::IfcMappedItem {
            extract_mapped_item_profiles(
                router,
                element_id,
                ifc_type,
                sub_item,
                &composed,
                unit_scale,
                profile_processor,
                decoder,
                model_index,
                depth + 1,
                results, skipped,
            );
        }
    }
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
    // Profile extraction feeds 2D drawing projection, not the tessellation-quality
    // render path; sample at the historical default.
    let profile =
        profile_processor.process(&profile_entity, decoder, TessellationQuality::Medium)?;

    if profile.outer.is_empty() {
        return Err(Error::geometry("empty profile"));
    }

    // Position, ExtrudedDirection and Depth, decoded and refused exactly as
    // `ExtrudedAreaSolidProcessor` does: a solid the 3D path cannot mesh has no
    // drawing profile either (it used to default Depth to 1.0 and a zero or
    // non-IfcDirection direction to +Z; PROC-2, #7690).
    let params = ExtrusionParams::decode(solid, decoder, "ExtrudedAreaSolid")?;
    let solid_transform = params
        .position
        .map(|t| scale_translation(t, unit_scale))
        .unwrap_or_else(Matrix4::identity);
    let local_dir = params.direction.normalize();
    let depth = params.depth * unit_scale;

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

/// Convert an IFC Z-up Matrix4 to WebGL Y-up column-major [f64; 16].
///
/// Conversion: new_y = old_z, new_z = -old_y (swap Y/Z, negate new Z).
/// Applied row-wise: row 0 stays, row 1 ← row 2, row 2 ← −row 1.
fn convert_ifc_to_webgl(m: &Matrix4<f64>) -> [f64; 16] {
    let mut result = [0.0f64; 16];
    for col in 0..4 {
        result[col * 4] = m[(0, col)]; // X row: unchanged
        result[col * 4 + 1] = m[(2, col)]; // Y row: was Z
        result[col * 4 + 2] = -m[(1, col)]; // Z row: was -Y
        result[col * 4 + 3] = m[(3, col)]; // homogeneous
    }
    result
}

/// Record a dropped profile for `element_id`.
fn skip(skipped: &mut Vec<SkippedProfile>, element_id: u32, ifc_type: &str, reason: String) {
    skipped.push(SkippedProfile { express_id: element_id, ifc_type: ifc_type.to_string(), reason });
}
