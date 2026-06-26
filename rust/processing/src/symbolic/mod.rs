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
//! - `IfcCircle` → [`SymbolicCircle`] (full circle).
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
//! - Per-product `ObjectPlacement` is resolved through the
//!   `IfcLocalPlacement` chain; symbolic uses a 2D
//!   translation-plus-rotation accumulation that intentionally diverges
//!   from the 3D geometry router so floor-plan annotations aren't
//!   distorted by parent rotations.
//! - Per-representation `ContextOfItems.WorldCoordinateSystem` is
//!   composed in when present (Plan reps occasionally use a different
//!   WCS than Body).
//! - RTC offset is auto-detected from the first geometry-bearing
//!   element and subtracted alongside the mesh pipeline.
//! - The Y-axis is flipped (`y → -y + rtc_z`) to match the renderer's
//!   section-cut coordinate convention.
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


use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};

mod color;
mod fill;
mod grid;
mod items;
mod primitives;
mod text;
mod transform;

pub use primitives::{
    SymbolicCircle, SymbolicData, SymbolicFillArea, SymbolicGridAxis, SymbolicPolyline, SymbolicText,
};

use color::build_styled_item_index;
use grid::extract_grid;
use items::extract_symbolic_item;
use transform::{compose_transforms, parse_axis2_placement_2d, resolve_object_placement, Transform2D};

// ────────────────────────────────────────────────────────────────────────────
// Top-level extraction. Mirror of the wasm `parse_symbolic_representations`
// scanner loop. Both paths feed the same `extract_*` helpers below so the
// server and browser produce bit-identical symbol streams.
// ────────────────────────────────────────────────────────────────────────────

/// Scan an IFC file for `IfcGrid` and any product carrying a Plan /
/// Annotation / FootPrint / Axis representation, and return the full
/// symbolic primitive collection. Pure-Rust (no `wasm_bindgen`), so it
/// works inside the HTTP server.
pub fn extract_symbolic_data<T>(content: &T) -> SymbolicData
where
    T: AsRef<[u8]> + ?Sized,
{
    let content = content.as_ref();
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // Reuse the geometry router for both unit-scale and the RTC offset.
    let router = ifc_lite_geometry::GeometryRouter::with_units(content, &mut decoder);
    let unit_scale = router.unit_scale() as f32;

    // RTC offset detection matches the wasm path so the symbolic stream
    // aligns with the mesh stream. The threshold (>10 km) is empirical —
    // anything smaller is local-coord territory where RTC subtraction
    // would shift things off-screen.
    let rtc_offset = router.detect_rtc_offset_from_first_element(content, &mut decoder);
    let needs_rtc = rtc_offset.0.abs() > 10_000.0
        || rtc_offset.1.abs() > 10_000.0
        || rtc_offset.2.abs() > 10_000.0;
    let rtc_x = if needs_rtc { rtc_offset.0 as f32 } else { 0.0 };
    let rtc_z = if needs_rtc { rtc_offset.2 as f32 } else { 0.0 };

    // Pre-pass: build a reverse index from "styled representation-item id"
    // to "list of style refs". Walked once at parse start (O(n)) so per-
    // item colour lookup is O(1) later. See `resolve_color_via_styles()`
    // for the chain (deprecated IfcPresentationStyleAssignment unwrap +
    // IfcFillAreaStyle → IfcColourRgb).
    let styled_items = build_styled_item_index(content, &mut decoder);

    let mut out = SymbolicData::default();
    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        let is_grid = type_name == "IFCGRID";
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
                rtc_x,
                rtc_z,
                &mut out,
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

        for shape_rep in representations {
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

            // ContextOfItems WCS: some Plan reps use a different coord
            // system than Body. Compose it in when present and non-trivial.
            let context_transform = match shape_rep.get_ref(0) {
                Some(context_ref) => match decoder.decode_by_id(context_ref) {
                    Ok(context) if context.ifc_type == IfcType::IfcGeometricRepresentationContext => {
                        match context.get_ref(2) {
                            Some(wcs_ref) => match decoder.decode_by_id(wcs_ref) {
                                Ok(wcs) => parse_axis2_placement_2d(&wcs, &mut decoder, unit_scale),
                                Err(_) => Transform2D::identity(),
                            },
                            None => Transform2D::identity(),
                        }
                    }
                    // SubContext inherits from parent — left as identity
                    // for now (the wasm pipeline does the same).
                    _ => Transform2D::identity(),
                },
                None => Transform2D::identity(),
            };
            let combined_transform = if context_transform.tx.abs() > 0.001
                || context_transform.ty.abs() > 0.001
                || (context_transform.cos_theta - 1.0).abs() > 0.0001
                || context_transform.sin_theta.abs() > 0.0001
            {
                compose_transforms(&context_transform, &placement_transform)
            } else {
                placement_transform
            };

            let Some(items_attr) = shape_rep.get(3) else {
                continue;
            };
            let Ok(items) = decoder.resolve_ref_list(items_attr) else {
                continue;
            };
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
                    &styled_items,
                    &mut out,
                );
            }
        }
    }

    out
}
