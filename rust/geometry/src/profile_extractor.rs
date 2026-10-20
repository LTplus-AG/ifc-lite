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
//! - `IfcMappedItem` — mapped levels with composed transforms
//! - The representations, mapped-item walk and bounds the mesh path uses
//!   ([`RepresentationWalk`] with `Select::Meshed`), and its element placement,
//!   mapping transforms and unit scale (`GeometryRouter`), so a drawing and the
//!   3D model agree on which solids exist and where (PROC-2, #7690; C2-X1)
//!
//! # Coordinate system
//! All output is in WebGL Y-up space (IFC Z-up converted: new_y = old_z, new_z = -old_y).
//! Lengths are in metres (unit scale applied).

use crate::processors::extrusion_params::ExtrusionParams;
use crate::profiles::ProfileProcessor;
use crate::representation::{
    Flow, MappedLevel, NestedMaps, RepresentationWalk, Select, WalkCtx, WalkRefusal, WalkVisitor,
    MAX_WALK_LEVELS,
};
use crate::router::GeometryRouter;
use crate::{profile_skip::SkippedProfile, Error, Result, TessellationQuality};
use ifc_lite_core::{
    build_entity_index, DecodedEntity, EntityDecoder, EntityScanner, IfcSchema, IfcType,
    MAX_MAPPED_ITEM_DEPTH,
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
    if router.length_unit_refused() {
        return (Vec::new(), Vec::new()); // a refused length unit extracts nothing (#7678)
    }
    let profile_processor = ProfileProcessor::new(IfcSchema::new());
    // What the mesh path renders (`Select::Meshed`: the effective
    // RepresentationType, the #4699 mapped-duplicate exclusion), bounded the way
    // the mesh path bounds it: the shared depth cap, the path-scoped visited set
    // and the fan-out budget (C2-X1, D36). The extractor used to select on the
    // RepresentationIdentifier and cap mapped chains at a private depth of 3.
    let walk = RepresentationWalk {
        select: Select::Meshed,
        nested: NestedMaps::Expand { max_depth: MAX_MAPPED_ITEM_DEPTH, max_levels: MAX_WALK_LEVELS },
    };

    let (mut results, mut skipped) = (Vec::new(), Vec::new());
    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::has_geometry_by_name(type_name) {
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else { continue };

        // Issue #979: feature elements (IfcOpeningElement and the rest of the
        // void/feature family) are boolean operands, not building structure —
        // they must never emit a construction-projection profile, and walking
        // the supertype chain covers the whole family in one check. Resolve
        // from `type_name`, not `entity.ifc_type`: only the legacy-aware
        // resolver preserves exact variants. Before support, bare `from_str` produced
        // `Unknown` and `IFCOPENINGSTANDARDCASE` emitted a profile (#3172).
        let resolved_type = ifc_lite_core::ifc_type_from_keyword(type_name);
        if resolved_type.is_subtype_of(IfcType::IfcFeatureElement) {
            continue;
        }

        let mut sink = ProfileSink {
            router: &router,
            profile_processor: &profile_processor,
            element: &entity,
            ifc_type: resolved_type.name(),
            model_index,
            placement: Placement::Unresolved,
            frames: Vec::new(),
            results: &mut results,
            skipped: &mut skipped,
        };
        // A shape chain that does not decode is not meshed either: nothing to
        // draw, and not a drop (an element without a representation is not one).
        let _ = walk.product(&entity, &mut decoder, &mut sink);
    }

    (results, skipped)
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE: THE WALK VISITOR
// ═══════════════════════════════════════════════════════════════════════════

/// The element's world placement (IFC Z-up, metres), resolved on the first
/// extractable item: an element with no extrusion never needs it.
enum Placement {
    Unresolved,
    Resolved(Matrix4<f64>),
    /// Reported once; nothing of the element can be drawn.
    Failed,
}

/// What the walk's visits mean to the 2D drawing: extrusion leaves become
/// profiles, mapped levels compose their transforms, and every refusal the walk
/// reports, and every leaf that cannot be extracted, becomes a
/// [`SkippedProfile`] of the element.
struct ProfileSink<'a> {
    router: &'a GeometryRouter,
    profile_processor: &'a ProfileProcessor,
    element: &'a DecodedEntity,
    ifc_type: &'a str,
    model_index: u32,
    placement: Placement,
    /// `placement · Π (MappingTarget · MappingOrigin)` per entered level,
    /// translation in metres: the mesh path's own composition (#1985).
    frames: Vec<Matrix4<f64>>,
    results: &'a mut Vec<ExtractedProfile>,
    skipped: &'a mut Vec<SkippedProfile>,
}

impl ProfileSink<'_> {
    /// The transform an item at the current level is placed by; `None` once the
    /// element's placement failed (reported here, once).
    fn frame(&mut self, decoder: &mut EntityDecoder) -> Option<Matrix4<f64>> {
        if let Some(frame) = self.frames.last() {
            return Some(*frame);
        }
        if let Placement::Unresolved = self.placement {
            self.placement = match self.router.resolve_scaled_placement(self.element, decoder) {
                Ok(m) => Placement::Resolved(Matrix4::from_column_slice(&m)),
                Err(e) => {
                    // The element's placement, not this item's: no later
                    // representation can be drawn either, so report it once.
                    self.drop(format!("placement: {e}"));
                    Placement::Failed
                }
            };
        }
        match self.placement {
            Placement::Resolved(m) => Some(m),
            _ => None,
        }
    }

    /// Record a dropped profile of the element.
    fn drop(&mut self, reason: String) {
        crate::diag::diag_debug!(
            { element_id = self.element.id, ifc_type = %self.ifc_type, reason = %reason,
              "profile_extractor: skipping profile" }
            else {
                #[cfg(feature = "debug_geometry")]
                eprintln!("[profile_extractor] Skipping #{} ({}): {reason}", self.element.id, self.ifc_type);
            }
        );
        self.skipped.push(SkippedProfile {
            express_id: self.element.id,
            ifc_type: self.ifc_type.to_string(),
            reason,
        });
    }
}

impl WalkVisitor for ProfileSink<'_> {
    fn item(&mut self, item: &DecodedEntity, _at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        if !is_extruded_area_solid(item.ifc_type.clone()) {
            return Flow::Continue;
        }
        let Some(frame) = self.frame(decoder) else { return Flow::Stop };
        let unit_scale = self.router.unit_scale();
        let (element, ifc_type) = (self.element.id, self.ifc_type);
        match extract_extruded_solid(element, ifc_type, item, &frame, unit_scale, self.profile_processor, decoder, self.model_index) {
            Ok(entry) => self.results.push(entry),
            Err(e) => self.drop(e.to_string()),
        }
        Flow::Continue
    }

    fn enter_map(&mut self, level: &MappedLevel, _at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        let Some(parent) = self.frame(decoder) else { return Flow::Stop };
        // MappingTarget · MappingOrigin, translation in metres: the mesh path's
        // own composition (#1985), so the drawing and the 3D item cannot
        // disagree about a target, a 2D origin or a broken reference.
        let (frame, flow) = match self.router.resolve_scaled_mapped_item_transform(&level.item, &level.map, decoder) {
            Ok(Some(m)) => (parent * Matrix4::from_column_slice(&m), Flow::Continue),
            Ok(None) => (parent, Flow::Continue),
            Err(e) => {
                self.drop(format!("mapped item #{}: {e}", level.item.id));
                (parent, Flow::SkipChildren)
            }
        };
        self.frames.push(frame);
        flow
    }

    fn leave_map(&mut self, _level: &MappedLevel) {
        self.frames.pop();
    }

    fn refused(&mut self, item: &DecodedEntity, why: WalkRefusal, _at: &WalkCtx<'_>) {
        // A failed placement is the element's only record (as it always was).
        // The walk refuses before a level is entered and hands no decoder, so a
        // refusal does not resolve the placement itself.
        if !matches!(self.placement, Placement::Failed) {
            self.drop(format!("mapped item #{}: {}", item.id, why.into_error(item.id)));
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
        .attr(ifc_lite_core::slot::IfcExtrudedAreaSolid::SWEPT_AREA)
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
