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

use crate::profiles::ProfileProcessor;
use crate::representation::{
    NestedMaps, RepresentationWalk, Select, WalkCtx, WalkVisitor,
    MAX_WALK_LEVELS,
};
use crate::router::GeometryRouter;
use crate::profile_skip::SkippedProfile;
use ifc_lite_core::{
    build_entity_index, DecodedEntity, EntityDecoder, EntityScanner, IfcSchema, IfcType,
    MAX_MAPPED_ITEM_DEPTH,
};

mod solid;
mod sink;
use sink::{Placement, ProfileSink};

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
/// A terminal execution stop ends the scan and retains completed profiles. This
/// tuple has no result-level typed stop: an `execution-stop:` reason is attached
/// only to a known affected product. WASM currently exposes only skipped IDs;
/// neither interface promises that a partial drawing is complete.
pub fn extract_profiles_with_diagnostics<T: AsRef<[u8]> + ?Sized>(content: &T, model_index: u32) -> (Vec<ExtractedProfile>, Vec<SkippedProfile>) {
    extract_profiles_with_budget(content, model_index, MAX_WALK_LEVELS)
}

pub(crate) fn extract_profiles_with_budget<T: AsRef<[u8]> + ?Sized>(
    content: &T, model_index: u32, allowance: u32,
) -> (Vec<ExtractedProfile>, Vec<SkippedProfile>) {
    // The public tuple has no result-level typed terminal. Before an affected
    // product is known, preserve the sticky stop without fabricating an ID.
    if crate::resource::check_current().is_err() { return (Vec::new(), Vec::new()); }
    let content = content.as_ref();
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // The mesh path's unit scale, placement walk and mapping transforms, so a
    // drawing can never place an element where the 3D model does not: this file
    // used to carry its own placement walk, which missed IfcLinearPlacement and
    // IfcGridPlacement (PROC-2, #7690).
    let router = GeometryRouter::with_units(content, &mut decoder);
    if crate::resource::check_current().is_err() { return (Vec::new(), Vec::new()); }
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

    loop {
        if crate::resource::check_current().is_err() { break; }
        let Some((id, type_name, start, end)) = scanner.next_entity() else { break };
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

        // Fallible only privately: a terminal ends the entire scan, retaining
        // already completed profiles and the original resource terminal.
        if let Err(error) = extract_product(
            &router, &profile_processor, &walk, &entity, resolved_type.name(),
            model_index, allowance, &mut decoder, &mut results, &mut skipped,
        ) {
            record_execution_stop(error, &entity, resolved_type.name(), &mut skipped);
            break;
        }
    }

    (results, skipped)
}


/// The scan knows the affected product here. Preserve a sticky resource stop
/// and distinguish this terminal from content failures in the existing tuple.
fn record_execution_stop(
    error: crate::Error, entity: &DecodedEntity, ifc_type: &str,
    skipped: &mut Vec<SkippedProfile>,
) {
    let error = match crate::resource::check_current() {
        Err(stop) => crate::Error::ProgramStopped(stop),
        Ok(()) => match error {
            crate::Error::ProgramStopped(stop) => crate::Error::ProgramStopped(crate::resource::stop(stop)),
            error => error, // execution-owner rejection also terminates the scan
        },
    };
    skipped.push(SkippedProfile {
        express_id: entity.id,
        ifc_type: ifc_type.to_string(),
        reason: format!("execution-stop: {error}"),
    });
}

#[allow(clippy::too_many_arguments)] // one private product extraction context
fn extract_product(
    router: &GeometryRouter, profile_processor: &ProfileProcessor,
    walk: &RepresentationWalk, entity: &DecodedEntity, ifc_type: &str,
    model_index: u32, allowance: u32, decoder: &mut EntityDecoder,
    results: &mut Vec<ExtractedProfile>, skipped: &mut Vec<SkippedProfile>,
) -> crate::Result<()> {
    let plan = crate::representation::product_budget::admit_product(entity, decoder, allowance, router);
    plan.validate(router, decoder)?;
    let mut sink = ProfileSink {
        router, profile_processor, element: entity, ifc_type, model_index,
        placement: Placement::Unresolved, frames: Vec::new(), results, skipped,
        terminal: None,
    };
    // A later ShapeError deliberately keeps earlier drawing profiles. Strict
    // mesh consumers instead call plan.strict() before any rendering.
    for (rep, items) in &plan.representations {
        for item in items {
            plan.validate(router, decoder)?;
            walk.items_of(rep, std::slice::from_ref(item), decoder, &mut sink);
            sink.finish()?;
        }
    }
    plan.validate(router, decoder)?;
    if let Some((item, why)) = plan.refusal {
        sink.refused(&item, why, &WalkCtx { element: Some(entity), shape_rep: None, path: &[] });
    }
    sink.finish()
}

#[cfg(test)]
mod execution_tests;
