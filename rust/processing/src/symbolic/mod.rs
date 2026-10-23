// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical 2D symbol extraction shared between the HTTP server and the
//! browser-side WASM bindings (issue #843 follow-up — full parity work).
//!
//! Walks an IFC once, extracts every symbolic primitive the renderer
//! understands (polylines, circles, texts, fill areas, grid axes +
//! bubbles), and returns pure-Rust serializable types. The browser path
//! in `rust/wasm-bindings/src/api/symbolic.rs` wraps the result into its
//! `wasm_bindgen` collection at the FFI boundary; the server path
//! serializes the same data structures directly via serde.
//!
//! Primitive coverage matches the wasm pipeline that ships to production:
//!
//! - `IfcPolyline`, `IfcIndexedPolyCurve` → [`SymbolicPolyline`].
//! - `IfcCircle` → [`SymbolicCircle`] for XY similarities, otherwise a sampled [`SymbolicPolyline`].
//! - `IfcEllipse` → [`SymbolicPolyline`] (64-segment tessellation).
//! - `IfcTrimmedCurve` on `IfcCircle` → [`SymbolicPolyline`] (arc with
//!   `PLANEANGLEUNIT` scaling, sense agreement, wrap-around). Near-
//!   collinear arcs (large radius, small sagitta) collapse to a line.
//! - `IfcCompositeCurve` → recurses into segments.
//! - `IfcGeometricSet` / `IfcGeometricCurveSet` → recurses into elements.
//! - `IfcMappedItem` → recurses into the mapped representation with
//!   `MappingOrigin` + `MappingTarget` transform composition.
//! - `IfcTextLiteral` / `IfcTextLiteralWithExtent` → [`SymbolicText`]
//!   with placement composition, `BoxAlignment`, glyph cap height
//!   derived from the extent box, colour via `IfcStyledItem` →
//!   `IfcTextStyle`.
//! - `IfcAnnotationFillArea` → [`SymbolicFillArea`] with outer ring,
//!   optional hole rings, colour via `IfcStyledItem` → `IfcFillAreaStyle`.
//! - `IfcGrid` → [`SymbolicPolyline`] (axis lines) + two [`SymbolicText`]
//!   bubbles per axis end (outline glyph + tag text).
//!
//! Coordinate handling matches the wasm pipeline:
//!
//! - Per-product `ObjectPlacement` is resolved through the shared 3D chain
//!   (`ifc_lite_geometry::placement::resolve_chain`: `IfcLocalPlacement`,
//!   `IfcLinearPlacement` and `IfcGridPlacement`, no depth cap, memoised on
//!   the decoder) and projected to XY. A symbol therefore lands where the mesh
//!   of the same product does; under a tilted parent it is foreshortened.
//! - Per-representation `ContextOfItems.WorldCoordinateSystem` is
//!   composed in when present (Plan reps occasionally use a different
//!   WCS than Body).
//! - The frame comes from the caller when it has one of its own — the native
//!   server, whose meshes travel in the same response, hands in
//!   `ProcessingResult::frame` (#4706) — and from the browser mesh frame
//!   selection (`MeshFrame::for_overlay`) otherwise.
//! - The whole RTC offset is subtracted — easting and northing into the
//!   plan pair (whose Y axis is flipped to match the renderer's section-cut
//!   handedness), elevation into `world_y` — and the frame's rotation, which
//!   only the site tier carries, comes out of the plan pair and out of the
//!   text baselines with it. `rebase::RenderFrameRebase` is the single place
//!   either conversion happens.
//!
//! Style resolution:
//!
//! - A reverse index from styled-representation-item id to concrete
//!   style refs is built up-front in O(n), unwrapping the deprecated
//!   `IfcPresentationStyleAssignment` so downstream resolvers don't
//!   need to know about it.
//! - Text colour walks `IfcTextStyle.TextCharacterAppearance` →
//!   `IfcTextStyleForDefinedFont.Colour` → `IfcColourRgb`.
//! - Fill colour walks `IfcFillAreaStyle.FillStyles` → first
//!   `IfcColourRgb`; hatching / tile fills are recognised but use a
//!   default fill colour.


use output_cap::SymbolicAccumulator;
use ifc_lite_core::resource_stop::ProgramStop;
use rebase::RenderFrameRebase;
use ifc_lite_core::{build_entity_index, keyword_eq, EntityDecoder, EntityScanner, IfcType};

mod color;
mod conic;
mod fill;
mod fill_provenance;
mod provenance;
pub use provenance::SymbolicDataWithProvenance;
mod grid;
mod item_walk;
mod items;
mod output_cap;
mod output_cap_types;
mod output_cap_validate;
#[cfg(test)]
mod items_cycle_tests;
#[cfg(test)]
mod output_cap_tests;
#[cfg(test)]
mod projected_conic_tests;
mod primitives;
mod rebase;
mod text;
mod transform;
mod trimmed_curve;

pub use output_cap_types::{SymbolicTruncation, SymbolicTruncationReason};
pub use primitives::{
    SymbolicCircle, SymbolicData, SymbolicFillArea, SymbolicGridAxis, SymbolicPolyline, SymbolicText,
};

use color::build_styled_item_index;
use grid::extract_grid;
use item_walk::extract_symbolic_item;
use transform::{compose_transforms, resolve_object_placement};

// ────────────────────────────────────────────────────────────────────────────
// Top-level extraction. Mirror of the wasm `parse_symbolic_representations`
// scanner loop. Both paths feed the same `extract_*` helpers below so the
// server and browser produce bit-identical symbol streams.
// ────────────────────────────────────────────────────────────────────────────

/// Scan an IFC file for `IfcGrid` and any product carrying a Plan /
/// Annotation / FootPrint / Axis representation, and return the full
/// symbolic primitive collection. Pure-Rust (no `wasm_bindgen`), so it
/// works inside the HTTP server.
///
/// In controlled execution, a terminal stop discards all staged symbols and
/// provenance and returns the exact `ProgramStop`. An empty successful collection
/// means no symbols were found; geometric truncation remains an `Ok` result.
pub fn extract_symbolic_data<T>(content: &T) -> Result<SymbolicData, ProgramStop>
where
    T: AsRef<[u8]> + ?Sized,
{
    extract_symbolic_data_with_provenance(content).map(|data| data.into_parts().0)
}

/// Extract symbols with ordinal-bound direct fill provenance, preserving the legacy data shape.
///
/// Resolves the OVERLAY frame (`MeshFrame::for_overlay`): the frame a consumer
/// that only parses the file can know. That is the browser's frame, and the
/// wasm binding (`rust/wasm-bindings/src/api/symbolic.rs`) is its caller. A
/// caller that also ran the native geometry pipeline must use
/// [`extract_symbolic_data_with_provenance_in_frame`] instead, or its symbols
/// and its meshes end up in two different frames (#4706).
pub fn extract_symbolic_data_with_provenance<T>(content: &T) -> Result<SymbolicDataWithProvenance, ProgramStop>
where
    T: AsRef<[u8]> + ?Sized,
{
    ifc_lite_geometry::resource::with_terminal_scope(|| {
        let mut out = SymbolicAccumulator::new();
        extract_symbolic_data_into(content, &mut out);
        out.into_provenance()
    })
}

/// Extract symbols in a frame the caller already chose: the native pipeline's
/// [`crate::ProcessingResult::frame`].
///
/// The server ships both streams in one response, so both must be in one
/// frame. `process_geometry` selects `MeshFrame::SiteLocal` for a translated
/// `IfcSite` and bakes its meshes as `Rᵀ · (P − t_site)`; before #4706 the
/// symbolic stream resolved its own frame here and kept both the site
/// translation and the site rotation the meshes had dropped. The frame is
/// handed in rather than re-derived so the two answers cannot differ.
pub fn extract_symbolic_data_with_provenance_in_frame<T>(
    content: &T,
    frame: crate::MeshFrame,
) -> Result<SymbolicDataWithProvenance, ProgramStop>
where
    T: AsRef<[u8]> + ?Sized,
{
    ifc_lite_geometry::resource::with_terminal_scope(|| {
        let mut out = SymbolicAccumulator::new();
        extract_symbolic_data_into_frame(content, Some(frame), &mut out);
        out.into_provenance()
    })
}

/// The overlay-frame extraction, writing into a caller-supplied accumulator.
///
/// Split out so a test can supply an accumulator with a small injected cap
/// and exercise the real path, instead of building a fixture that emits two
/// million primitives to reach `MAX_SYMBOLIC_ELEMENTS`.
fn extract_symbolic_data_into<T>(content: &T, out: &mut SymbolicAccumulator)
where
    T: AsRef<[u8]> + ?Sized,
{
    extract_symbolic_data_into_frame(content, None, out)
}

/// The extraction itself. `frame` is `None` when the caller has no frame of
/// its own and this must resolve the overlay one.
fn extract_symbolic_data_into_frame<T>(
    content: &T,
    frame: Option<crate::MeshFrame>,
    out: &mut SymbolicAccumulator,
)
where
    T: AsRef<[u8]> + ?Sized,
{
    if out.is_exhausted() { return; }
    let content = content.as_ref();
    let entity_index = build_entity_index(content);
    // Symbolic geometry refuses unrepresentable reals (#7678, D15).
    let mut decoder = EntityDecoder::with_index(content, entity_index).with_strict_reals();
    // Reuse the geometry router for both unit-scale and the RTC offset.
    // Not drained: meshes nothing. Pinned by rust/geometry/tests/issue_3821_auxiliary_routers_mesh_nothing.rs.
    let router = ifc_lite_geometry::GeometryRouter::with_units(content, &mut decoder);
    if router.length_unit_refused() { return; } // a refused unit draws nothing (#7678)
    let unit_scale = router.unit_scale();
    // Re-based by the frame the caller's meshes are in, or - when it has none
    // - by the browser mesh frame this can resolve for itself (#4706).
    let frame =
        frame.unwrap_or_else(|| crate::MeshFrame::for_overlay(&router, content, &mut decoder));
    let rebase = RenderFrameRebase::from_frame(frame);

    // Pre-pass: build a reverse index from "styled representation-item id"
    // to "list of style refs". Walked once at parse start (O(n)) so per-
    // item colour lookup is O(1) later. See `resolve_color_via_styles()`
    // for the chain (deprecated IfcPresentationStyleAssignment unwrap +
    // IfcFillAreaStyle → IfcColourRgb).
    let styled_items = build_styled_item_index(content, &mut decoder);

    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        #[cfg(test)]
        output_cap::execution_tests::on_entity(id, out);
        // Stop the SCAN, not just the innermost item loop. Breaking only the
        // inner loop still decodes every remaining product, resolves its
        // placements and composes its transforms, which is not the "stop" this
        // bound claims. Bounded by file size rather than by the fan-out, so it
        // was never the DoS lever -- but it is work with a known-useless
        // result.
        if out.is_exhausted() {
            break;
        }
        let is_grid = keyword_eq(type_name, "IFCGRID");
        if !is_grid && !ifc_lite_core::has_geometry_by_name(type_name) {
            // IfcGrid isn't in `has_geometry_by_name` (it's not a building
            // element) but carries axis curves that we render as symbolic
            // lines + bubbles + tags.
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };

        if is_grid {
            let grid_transform = resolve_object_placement(&entity, &mut decoder, unit_scale);
            extract_grid(
                &entity,
                id,
                &mut decoder,
                unit_scale,
                &grid_transform,
                rebase,
                out,
            );
            continue;
        }

        // Standard representation walk: IfcProductDefinitionShape → Plan /
        // Annotation / FootPrint / Axis IfcShapeRepresentation → items.
        let Some(representation_attr) = entity.get(6) else {
            continue;
        };
        if representation_attr.is_null() {
            continue;
        }
        let Ok(Some(representation)) = decoder.resolve_ref(representation_attr) else {
            continue;
        };
        let Some(reps_attr) = representation.get(2) else {
            continue;
        };
        let Ok(representations) = decoder.resolve_ref_list(reps_attr) else {
            continue;
        };

        let ifc_type_name = entity.ifc_type.name().to_string();

        let single_representation = representations.len() == 1;
        for shape_rep in representations {
            if out.is_exhausted() { break; }
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }
            let rep_identifier = shape_rep
                .get(1)
                .and_then(|a| a.as_string())
                .unwrap_or("")
                .to_string();
            if !matches!(
                rep_identifier.as_str(),
                "Plan" | "Annotation" | "FootPrint" | "Axis"
            ) {
                continue;
            }

            // ObjectPlacement transform for this entity (translations
            // accumulated directly, rotations accumulated to orient symbols).
            let placement_transform = resolve_object_placement(&entity, &mut decoder, unit_scale);

            let context_transform = transform::resolve_context_transform(&shape_rep, &mut decoder, unit_scale);
            // A small 3D WCS rotation can couple a large local Z into plan
            // XY. Compose before projection without an approximate identity
            // shortcut, even when its XY block appears unchanged (#7779).
            let combined_transform = compose_transforms(&context_transform, &placement_transform);

            let Some(items_attr) = shape_rep.get(3) else {
                continue;
            };
            let Ok(items) = decoder.resolve_ref_list(items_attr) else {
                continue;
            };
            let direct_fill_ids = fill_provenance::direct_fill_ids(&items, single_representation);
            for item in items {
                if out.is_exhausted() {
                    break;
                }
                extract_symbolic_item(
                    &item,
                    &mut decoder,
                    id,
                    &ifc_type_name,
                    &rep_identifier,
                    unit_scale,
                    &combined_transform,
                    rebase,
                    &styled_items,
                    out,
                    direct_fill_ids.contains(&item.id).then_some(item.id),
                );
            }
        }
    }

}
