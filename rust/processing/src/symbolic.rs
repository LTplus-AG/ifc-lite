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

use ifc_lite_core::{
    build_entity_index, AttributeValue, DecodedEntity, EntityDecoder, EntityScanner, IfcType,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ────────────────────────────────────────────────────────────────────────────
// Pure-Rust serializable primitive types. The wasm-bindgen wrappers in
// `rust/wasm-bindings/src/zero_copy.rs` are thin views over these.
// ────────────────────────────────────────────────────────────────────────────

/// A single 2D polyline for symbolic representations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolicPolyline {
    /// Express ID of the IFC entity that authored the curve.
    pub express_id: u32,
    /// Owning element's IFC type name.
    pub ifc_type: String,
    /// Flat 2D points `[x0, y0, x1, y1, …]` in metres.
    pub points: Vec<f32>,
    /// True if the curve is a closed loop.
    pub closed: bool,
    /// World-Y elevation captured from the placement chain or the
    /// polyline's own 3D `IfcCartesianPoint` Z component.
    pub world_y: f32,
    /// Representation identifier (`Plan`, `Annotation`, `FootPrint`, `Axis`).
    pub representation: String,
}

/// A single 2D circle / arc for symbolic representations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolicCircle {
    pub express_id: u32,
    pub ifc_type: String,
    pub center_x: f32,
    pub center_y: f32,
    pub radius: f32,
    /// World-Y elevation (see [`SymbolicPolyline::world_y`]).
    pub world_y: f32,
    /// Start angle in radians (0 for full circle).
    pub start_angle: f32,
    /// End angle in radians (`TAU` for full circle).
    pub end_angle: f32,
    pub representation: String,
}

impl SymbolicCircle {
    /// Full-circle constructor.
    pub fn full(
        express_id: u32,
        ifc_type: String,
        center_x: f32,
        center_y: f32,
        radius: f32,
        world_y: f32,
        representation: String,
    ) -> Self {
        Self {
            express_id,
            ifc_type,
            center_x,
            center_y,
            radius,
            world_y,
            start_angle: 0.0,
            end_angle: std::f32::consts::TAU,
            representation,
        }
    }
}

/// A 2D text annotation (`IfcTextLiteral` / `IfcTextLiteralWithExtent`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolicText {
    pub express_id: u32,
    pub ifc_type: String,
    /// Anchor point on the text baseline (model units).
    pub x: f32,
    pub y: f32,
    /// Baseline orientation as a `(cos, sin)` pair. Defaults to `(1, 0)`.
    pub dir_x: f32,
    pub dir_y: f32,
    /// Font height in model units (already unit-scaled).
    pub height: f32,
    /// UTF-8 text content (verbatim from the IFC literal — JS-side
    /// decodes any `\X2\…\X0\` escape sequences).
    pub content: String,
    /// IFC `BoxAlignment` (`top-left`, `center`, `bottom-right`, …). Empty
    /// string when absent.
    pub alignment: String,
    /// World-Y elevation (see [`SymbolicPolyline::world_y`]).
    pub world_y: f32,
    /// sRGB straight-alpha colour `[r, g, b, a]`. Defaults to dark-grey
    /// when no IfcStyledItem chain resolves a colour.
    pub color: [f32; 4],
    /// Per-instance target screen-pixel cap height. `0.0` = renderer
    /// global default (~14 px for body text).
    pub target_px: f32,
    pub representation: String,
}

/// A 2D filled region (`IfcAnnotationFillArea`).
///
/// Outer ring + optional inner rings (holes) packed into a single `points`
/// buffer. `holes_offsets[i]` is the vertex index where hole `i` begins —
/// outer ring spans `[0, holes_offsets[0])` (or all points when no holes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolicFillArea {
    pub express_id: u32,
    pub ifc_type: String,
    /// All ring vertices: outer ring first, then each hole back-to-back.
    /// Format: `[x0, y0, x1, y1, …]`.
    pub points: Vec<f32>,
    /// Inclusive prefix of where each hole begins (in vertex indices).
    pub holes_offsets: Vec<u32>,
    /// Fill colour sRGB, 0..1. Defaults to opaque black.
    pub fill_color: [f32; 4],
    /// Whether this fill carries a hatching style.
    pub has_hatching: bool,
    pub hatch_spacing: f32,
    pub hatch_angle: f32,
    /// Secondary cross-hatch angle. NaN if absent.
    pub hatch_angle_secondary: f32,
    pub hatch_line_width: f32,
    pub world_y: f32,
    pub representation: String,
}

/// A single `IfcGridAxis` tag + axis curve (server-friendly endpoint-pair
/// representation; the wasm pipeline emits the same data via
/// [`SymbolicPolyline`] axis lines and [`SymbolicText`] bubbles, both of
/// which are also populated below).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolicGridAxis {
    pub express_id: u32,
    pub grid_express_id: u32,
    pub tag: String,
    /// Endpoint pair `[x0, y0, x1, y1]` in metres (plan view).
    pub endpoints: [f32; 4],
    pub world_y: f32,
}

/// Server-friendly summary of the IFC's 2D symbol data.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SymbolicData {
    /// Axis endpoints for every `IfcGridAxis` (compact summary shape).
    pub grid_axes: Vec<SymbolicGridAxis>,
    /// All polylines (`IfcPolyline`, `IfcIndexedPolyCurve`, `IfcEllipse`
    /// tessellations, `IfcTrimmedCurve` arcs, grid axis lines).
    pub polylines: Vec<SymbolicPolyline>,
    /// All circles (`IfcCircle` full disks).
    pub circles: Vec<SymbolicCircle>,
    /// All text annotations (`IfcTextLiteral`, grid bubble outlines + tags).
    pub texts: Vec<SymbolicText>,
    /// All filled regions (`IfcAnnotationFillArea`).
    pub fills: Vec<SymbolicFillArea>,
}

impl SymbolicData {
    /// Returns true if no symbolic primitives were extracted — the server
    /// can omit the field from its response instead of emitting an empty
    /// object.
    pub fn is_empty(&self) -> bool {
        self.grid_axes.is_empty()
            && self.polylines.is_empty()
            && self.circles.is_empty()
            && self.texts.is_empty()
            && self.fills.is_empty()
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level extraction. Mirror of the wasm `parse_symbolic_representations`
// scanner loop. Both paths feed the same `extract_*` helpers below so the
// server and browser produce bit-identical symbol streams.
// ────────────────────────────────────────────────────────────────────────────

/// Scan an IFC file for `IfcGrid` and any product carrying a Plan /
/// Annotation / FootPrint / Axis representation, and return the full
/// symbolic primitive collection. Pure-Rust (no `wasm_bindgen`), so it
/// works inside the HTTP server.
pub fn extract_symbolic_data(content: &str) -> SymbolicData {
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

// ────────────────────────────────────────────────────────────────────────────
// 2D transform primitives. Floor-plan symbolic rendering uses a custom
// 2D-only transform: translations accumulate directly (not rotated by parent
// rotations), but rotations DO accumulate so symbols orient correctly.
// `tz` is strictly additive along the chain and lets each primitive carry
// its storey elevation forward via `world_y`.
// ────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
struct Transform2D {
    tx: f32,
    ty: f32,
    tz: f32,
    cos_theta: f32,
    sin_theta: f32,
}

impl Transform2D {
    fn identity() -> Self {
        Self {
            tx: 0.0,
            ty: 0.0,
            tz: 0.0,
            cos_theta: 1.0,
            sin_theta: 0.0,
        }
    }

    fn transform_point(&self, x: f32, y: f32) -> (f32, f32) {
        let rx = x * self.cos_theta - y * self.sin_theta;
        let ry = x * self.sin_theta + y * self.cos_theta;
        (rx + self.tx, ry + self.ty)
    }
}

/// Compose two 2D transforms: `result = a * b` (apply `b` first, then `a`).
fn compose_transforms(a: &Transform2D, b: &Transform2D) -> Transform2D {
    let combined_cos = a.cos_theta * b.cos_theta - a.sin_theta * b.sin_theta;
    let combined_sin = a.sin_theta * b.cos_theta + a.cos_theta * b.sin_theta;
    let rtx = b.tx * a.cos_theta - b.ty * a.sin_theta;
    let rty = b.tx * a.sin_theta + b.ty * a.cos_theta;
    Transform2D {
        tx: rtx + a.tx,
        ty: rty + a.ty,
        tz: a.tz + b.tz,
        cos_theta: combined_cos,
        sin_theta: combined_sin,
    }
}

/// Resolve a product's `ObjectPlacement` (attribute 5) into a 2D transform.
fn resolve_object_placement(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
) -> Transform2D {
    let Some(attr) = entity.get(5) else {
        return Transform2D::identity();
    };
    if attr.is_null() {
        return Transform2D::identity();
    }
    let Ok(Some(placement)) = decoder.resolve_ref(attr) else {
        return Transform2D::identity();
    };
    resolve_placement_for_symbolic(&placement, decoder, unit_scale, 0)
}

/// Recursively resolve `IfcLocalPlacement` for 2D symbolic representations.
/// Mirrors the wasm pipeline's accumulation rule exactly.
fn resolve_placement_for_symbolic(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
    depth: usize,
) -> Transform2D {
    if depth > 50 || placement.ifc_type != IfcType::IfcLocalPlacement {
        return Transform2D::identity();
    }

    let parent_transform = match placement.get(0) {
        Some(parent_attr) if !parent_attr.is_null() => match decoder.resolve_ref(parent_attr) {
            Ok(Some(parent)) => {
                resolve_placement_for_symbolic(&parent, decoder, unit_scale, depth + 1)
            }
            _ => Transform2D::identity(),
        },
        _ => Transform2D::identity(),
    };

    let local_transform = match placement.get(1) {
        Some(rel_attr) if !rel_attr.is_null() => match decoder.resolve_ref(rel_attr) {
            Ok(Some(rel))
                if rel.ifc_type == IfcType::IfcAxis2Placement3D
                    || rel.ifc_type == IfcType::IfcAxis2Placement2D =>
            {
                parse_axis2_placement_2d(&rel, decoder, unit_scale)
            }
            _ => Transform2D::identity(),
        },
        _ => Transform2D::identity(),
    };

    let combined_cos = parent_transform.cos_theta * local_transform.cos_theta
        - parent_transform.sin_theta * local_transform.sin_theta;
    let combined_sin = parent_transform.sin_theta * local_transform.cos_theta
        + parent_transform.cos_theta * local_transform.sin_theta;

    let rotated_local_tx = local_transform.tx * parent_transform.cos_theta
        - local_transform.ty * parent_transform.sin_theta;
    let rotated_local_ty = local_transform.tx * parent_transform.sin_theta
        + local_transform.ty * parent_transform.cos_theta;

    Transform2D {
        tx: parent_transform.tx + rotated_local_tx,
        ty: parent_transform.ty + rotated_local_ty,
        tz: parent_transform.tz + local_transform.tz,
        cos_theta: combined_cos,
        sin_theta: combined_sin,
    }
}

/// Parse `IfcAxis2Placement3D` / `IfcAxis2Placement2D` to a 2D transform.
/// Floor-plan uses X-Y (Z is up) to match the section-cut coord system.
fn parse_axis2_placement_2d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
) -> Transform2D {
    let is_3d = placement.ifc_type == IfcType::IfcAxis2Placement3D;

    let (tx, ty, tz) = match placement.get_ref(0) {
        Some(loc_ref) => match decoder.decode_by_id(loc_ref) {
            Ok(loc) if loc.ifc_type == IfcType::IfcCartesianPoint => {
                let coords = loc
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let raw_x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let raw_y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let raw_z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                (raw_x * unit_scale, raw_y * unit_scale, raw_z * unit_scale)
            }
            _ => (0.0, 0.0, 0.0),
        },
        None => (0.0, 0.0, 0.0),
    };

    // RefDirection lives at attr 2 for 3D, attr 1 for 2D.
    let ref_dir_attr = if is_3d {
        placement.get(2)
    } else {
        placement.get(1)
    };
    let (cos_theta, sin_theta) = match ref_dir_attr {
        Some(attr) if !attr.is_null() => match attr.as_entity_ref() {
            Some(ref_dir_id) => match decoder.decode_by_id(ref_dir_id) {
                Ok(ref_dir) if ref_dir.ifc_type == IfcType::IfcDirection => {
                    let ratios = ref_dir
                        .get(0)
                        .and_then(|a| a.as_list())
                        .map(|l| l.to_vec())
                        .unwrap_or_default();
                    let dx = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
                    let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                    let dz = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                    let len = (dx * dx + dy * dy).sqrt();
                    if len > 0.0001 {
                        (dx / len, dy / len)
                    } else if is_3d && dz.abs() > 0.0001 {
                        // RefDirection purely in Z (vertical) — local X
                        // points up/down, rotation is 0° in floor plan.
                        (1.0, 0.0)
                    } else {
                        (1.0, 0.0)
                    }
                }
                _ => (1.0, 0.0),
            },
            None => (1.0, 0.0),
        },
        _ => (1.0, 0.0),
    };

    Transform2D {
        tx,
        ty,
        tz,
        cos_theta,
        sin_theta,
    }
}

/// Parse `IfcCartesianTransformationOperator2D` / `…3D` for `IfcMappedItem`
/// targets. The wasm pipeline currently only honours translation +
/// uniform-scale rotation; we mirror that.
fn parse_cartesian_transformation_operator(
    operator: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
) -> Transform2D {
    // attr 2 = LocalOrigin (IfcCartesianPoint).
    let (tx, ty) = match operator.get_ref(2) {
        Some(loc_ref) => match decoder.decode_by_id(loc_ref) {
            Ok(loc) if loc.ifc_type == IfcType::IfcCartesianPoint => {
                let coords = loc
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                (x * unit_scale, y * unit_scale)
            }
            _ => (0.0, 0.0),
        },
        None => (0.0, 0.0),
    };

    // Axis1 (attr 0) gives the X direction for 2D / 3D operators.
    let (cos_theta, sin_theta) = match operator.get_ref(0) {
        Some(ax_ref) => match decoder.decode_by_id(ax_ref) {
            Ok(ax) if ax.ifc_type == IfcType::IfcDirection => {
                let ratios = ax
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let dx = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
                let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let len = (dx * dx + dy * dy).sqrt();
                if len > 0.0001 {
                    (dx / len, dy / len)
                } else {
                    (1.0, 0.0)
                }
            }
            _ => (1.0, 0.0),
        },
        None => (1.0, 0.0),
    };

    Transform2D {
        tx,
        ty,
        tz: 0.0,
        cos_theta,
        sin_theta,
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Item dispatch. One function per IFC representation-item type; recursive
// for set + mapped-item containers.
// ────────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn extract_symbolic_item(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    styled_items: &HashMap<u32, Vec<u32>>,
    out: &mut SymbolicData,
) {
    match item.ifc_type {
        IfcType::IfcGeometricSet | IfcType::IfcGeometricCurveSet => {
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
                            styled_items,
                            out,
                        );
                    }
                }
            }
        }
        IfcType::IfcMappedItem => {
            let Some(source_id) = item.get_ref(0) else { return };
            let Ok(rep_map) = decoder.decode_by_id(source_id) else { return };

            // MappingOrigin (rep_map attr 0) defines the local coord origin.
            let mapping_origin_transform = match rep_map.get_ref(0) {
                Some(origin_id) => match decoder.decode_by_id(origin_id) {
                    Ok(origin) => parse_axis2_placement_2d(&origin, decoder, unit_scale),
                    Err(_) => Transform2D::identity(),
                },
                None => Transform2D::identity(),
            };
            // MappingTarget (item attr 1) — additional transform.
            let mapping_target_transform = match item.get_ref(1) {
                Some(target_ref) => match decoder.decode_by_id(target_ref) {
                    Ok(target) => parse_cartesian_transformation_operator(&target, decoder, unit_scale),
                    Err(_) => Transform2D::identity(),
                },
                None => Transform2D::identity(),
            };
            let origin_with_target =
                compose_transforms(&mapping_target_transform, &mapping_origin_transform);
            let composed_transform = compose_transforms(transform, &origin_with_target);

            if let Some(mapped_rep_id) = rep_map.get_ref(1) {
                if let Ok(mapped_rep) = decoder.decode_by_id(mapped_rep_id) {
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
                                    styled_items,
                                    out,
                                );
                            }
                        }
                    }
                }
            }
        }
        IfcType::IfcPolyline => {
            if let Some(points_attr) = item.get(0) {
                if let Ok(point_entities) = decoder.resolve_ref_list(points_attr) {
                    let mut points: Vec<f32> = Vec::with_capacity(point_entities.len() * 2);
                    let mut first_z: Option<f32> = None;
                    for pe in point_entities.iter() {
                        if pe.ifc_type != IfcType::IfcCartesianPoint {
                            continue;
                        }
                        let coords = match pe.get(0).and_then(|a| a.as_list()) {
                            Some(c) => c,
                            None => continue,
                        };
                        let local_x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                        let local_y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                        let local_z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                        if first_z.is_none() {
                            first_z = Some(local_z);
                        }
                        let (wx, wy) = transform.transform_point(local_x, local_y);
                        let x = wx - rtc_x;
                        let y = -wy + rtc_z; // Y-flip to match section-cut coord system
                        if x.is_finite() && y.is_finite() {
                            points.push(x);
                            points.push(y);
                        }
                    }
                    if points.len() >= 4 {
                        let n = points.len();
                        let is_closed = n >= 4
                            && (points[0] - points[n - 2]).abs() < 0.001
                            && (points[1] - points[n - 1]).abs() < 0.001;
                        let world_y = first_z.unwrap_or(0.0) + transform.tz;
                        out.polylines.push(SymbolicPolyline {
                            express_id,
                            ifc_type: ifc_type.to_string(),
                            points,
                            closed: is_closed,
                            world_y,
                            representation: rep_identifier.to_string(),
                        });
                    }
                }
            }
        }
        IfcType::IfcIndexedPolyCurve => {
            let Some(points_ref) = item.get_ref(0) else { return };
            let Ok(points_list) = decoder.decode_by_id(points_ref) else { return };
            let Some(coord_list_attr) = points_list.get(0) else { return };
            let Some(coord_list) = coord_list_attr.as_list() else { return };
            let mut points: Vec<f32> = Vec::with_capacity(coord_list.len() * 2);
            let mut first_z: Option<f32> = None;
            for coord in coord_list {
                let Some(coords) = coord.as_list() else { continue };
                let local_x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let local_y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let local_z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                if first_z.is_none() {
                    first_z = Some(local_z);
                }
                let (wx, wy) = transform.transform_point(local_x, local_y);
                let x = wx - rtc_x;
                let y = -wy + rtc_z;
                if x.is_finite() && y.is_finite() {
                    points.push(x);
                    points.push(y);
                }
            }
            if points.len() >= 4 {
                let n = points.len();
                let is_closed = n >= 4
                    && (points[0] - points[n - 2]).abs() < 0.001
                    && (points[1] - points[n - 1]).abs() < 0.001;
                let world_y = first_z.unwrap_or(0.0) + transform.tz;
                out.polylines.push(SymbolicPolyline {
                    express_id,
                    ifc_type: ifc_type.to_string(),
                    points,
                    closed: is_closed,
                    world_y,
                    representation: rep_identifier.to_string(),
                });
            }
        }
        IfcType::IfcCircle => {
            let radius = item.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            if radius <= 0.0 || !radius.is_finite() {
                return;
            }
            let (center_x, center_y, center_z) = circle_center(item, decoder, unit_scale);
            if !center_x.is_finite() || !center_y.is_finite() {
                return;
            }
            let (wx, wy) = transform.transform_point(center_x, center_y);
            out.circles.push(SymbolicCircle::full(
                express_id,
                ifc_type.to_string(),
                wx - rtc_x,
                -wy + rtc_z,
                radius,
                center_z + transform.tz,
                rep_identifier.to_string(),
            ));
        }
        IfcType::IfcEllipse => {
            let semi_a = item.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            let semi_b = item.get(2).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            if semi_a <= 0.0 || semi_b <= 0.0 || !semi_a.is_finite() || !semi_b.is_finite() {
                return;
            }
            let (cx_local, cy_local, cz_local) = circle_center(item, decoder, unit_scale);
            const SEGMENTS: usize = 64;
            let mut points: Vec<f32> = Vec::with_capacity((SEGMENTS + 1) * 2);
            for i in 0..=SEGMENTS {
                let t = (i as f32) * std::f32::consts::TAU / (SEGMENTS as f32);
                let lx = cx_local + semi_a * t.cos();
                let ly = cy_local + semi_b * t.sin();
                let (wx, wy) = transform.transform_point(lx, ly);
                let x = wx - rtc_x;
                let y = -wy + rtc_z;
                if x.is_finite() && y.is_finite() {
                    points.push(x);
                    points.push(y);
                }
            }
            if points.len() >= 4 {
                out.polylines.push(SymbolicPolyline {
                    express_id,
                    ifc_type: ifc_type.to_string(),
                    points,
                    closed: true,
                    world_y: cz_local + transform.tz,
                    representation: rep_identifier.to_string(),
                });
            }
        }
        IfcType::IfcTrimmedCurve => {
            extract_trimmed_curve(
                item,
                decoder,
                express_id,
                ifc_type,
                rep_identifier,
                unit_scale,
                transform,
                rtc_x,
                rtc_z,
                out,
            );
        }
        IfcType::IfcCompositeCurve => {
            if let Some(segments_attr) = item.get(0) {
                if let Ok(segments) = decoder.resolve_ref_list(segments_attr) {
                    for segment in segments {
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
                                    styled_items,
                                    out,
                                );
                            }
                        }
                    }
                }
            }
        }
        IfcType::IfcLine => {
            // Infinite — no sensible 2D segment to emit.
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
                styled_items,
                out,
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
                styled_items,
                out,
            );
        }
        _ => {
            // Unknown / unsupported curve type — skip silently.
        }
    }
}

/// Resolve a circle / ellipse Position → Location → (x, y, z) in metres.
fn circle_center(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
) -> (f32, f32, f32) {
    let Some(pos_ref) = item.get_ref(0) else {
        return (0.0, 0.0, 0.0);
    };
    let Ok(placement) = decoder.decode_by_id(pos_ref) else {
        return (0.0, 0.0, 0.0);
    };
    let Some(loc_ref) = placement.get_ref(0) else {
        return (0.0, 0.0, 0.0);
    };
    let Ok(loc) = decoder.decode_by_id(loc_ref) else {
        return (0.0, 0.0, 0.0);
    };
    let Some(coords) = loc.get(0).and_then(|a| a.as_list()) else {
        return (0.0, 0.0, 0.0);
    };
    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
    (x, y, z)
}

/// Tessellate an `IfcTrimmedCurve` whose `BasisCurve` is an `IfcCircle`.
/// Honours `PLANEANGLEUNIT` scaling, `SenseAgreement`, and wrap-around so
/// the 2D arc matches the 3D arc on the same curve. Near-collinear arcs
/// (large radius, small sagitta) collapse to a straight segment.
#[allow(clippy::too_many_arguments)]
fn extract_trimmed_curve(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    out: &mut SymbolicData,
) {
    let Some(basis_ref) = item.get_ref(0) else { return };
    let Ok(basis_curve) = decoder.decode_by_id(basis_ref) else { return };
    if basis_curve.ifc_type != IfcType::IfcCircle {
        return;
    }
    let radius = basis_curve.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
    if radius <= 0.0 || !radius.is_finite() {
        return;
    }
    let (center_x, center_y, center_z) = circle_center(&basis_curve, decoder, unit_scale);
    if !center_x.is_finite() || !center_y.is_finite() {
        return;
    }
    let world_y = center_z + transform.tz;

    let angle_scale = decoder.plane_angle_to_radians() as f32;
    let raw_trim1: Option<f32> = item
        .get(1)
        .and_then(|a| a.as_list().and_then(|l| l.first().and_then(|v| v.as_float())))
        .map(|v| v as f32);
    let raw_trim2: Option<f32> = item
        .get(2)
        .and_then(|a| a.as_list().and_then(|l| l.first().and_then(|v| v.as_float())))
        .map(|v| v as f32);
    let sense = item
        .get(3)
        .and_then(|v| match v {
            AttributeValue::Enum(s) => Some(s == "T" || s == "TRUE" || s == ".T."),
            _ => None,
        })
        .unwrap_or(true);

    let start_angle = raw_trim1.map(|v| v * angle_scale).unwrap_or(0.0);
    let mut end_angle = raw_trim2.map(|v| v * angle_scale).unwrap_or(std::f32::consts::TAU);
    if sense && end_angle < start_angle {
        end_angle += std::f32::consts::TAU;
    } else if !sense && end_angle > start_angle {
        end_angle -= std::f32::consts::TAU;
    }
    if !start_angle.is_finite() || !end_angle.is_finite() {
        return;
    }

    let start_x = center_x + radius * start_angle.cos();
    let start_y = center_y + radius * start_angle.sin();
    let end_x = center_x + radius * end_angle.cos();
    let end_y = center_y + radius * end_angle.sin();
    let chord_dx = end_x - start_x;
    let chord_dy = end_y - start_y;
    let chord_len = (chord_dx * chord_dx + chord_dy * chord_dy).sqrt();
    let is_near_collinear = if chord_len > 0.0001 {
        let mid_angle = (start_angle + end_angle) / 2.0;
        let mid_x = center_x + radius * mid_angle.cos();
        let mid_y = center_y + radius * mid_angle.sin();
        let sagitta = ((end_y - start_y) * mid_x - (end_x - start_x) * mid_y
            + end_x * start_y
            - end_y * start_x)
            .abs()
            / chord_len;
        radius > 100.0 || sagitta < chord_len * 0.02 || radius > chord_len * 10.0
    } else {
        true
    };

    if is_near_collinear {
        let (wsx, wsy) = transform.transform_point(start_x, start_y);
        let (wex, wey) = transform.transform_point(end_x, end_y);
        let points = vec![wsx - rtc_x, -wsy + rtc_z, wex - rtc_x, -wey + rtc_z];
        out.polylines.push(SymbolicPolyline {
            express_id,
            ifc_type: ifc_type.to_string(),
            points,
            closed: false,
            world_y,
            representation: rep_identifier.to_string(),
        });
    } else {
        let arc_length = (end_angle - start_angle).abs();
        let num_segments = ((arc_length * radius / 0.1) as usize).max(8).min(64);
        let mut points = Vec::with_capacity((num_segments + 1) * 2);
        for i in 0..=num_segments {
            let t = i as f32 / num_segments as f32;
            let angle = start_angle + t * (end_angle - start_angle);
            let local_x = center_x + radius * angle.cos();
            let local_y = center_y + radius * angle.sin();
            let (wx, wy) = transform.transform_point(local_x, local_y);
            let x = wx - rtc_x;
            let y = -wy + rtc_z;
            if x.is_finite() && y.is_finite() {
                points.push(x);
                points.push(y);
            }
        }
        if points.len() >= 4 {
            out.polylines.push(SymbolicPolyline {
                express_id,
                ifc_type: ifc_type.to_string(),
                points,
                closed: false,
                world_y,
                representation: rep_identifier.to_string(),
            });
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Text extraction (IfcTextLiteral / IfcTextLiteralWithExtent).
// ────────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn extract_text_literal(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    styled_items: &HashMap<u32, Vec<u32>>,
    out: &mut SymbolicData,
) {
    let content = match item.get(0).and_then(|a| a.as_string()) {
        Some(s) => s.to_string(),
        None => return,
    };

    let placement_transform = match item.get_ref(1) {
        Some(p_ref) => match decoder.decode_by_id(p_ref) {
            Ok(p) => parse_axis2_placement_2d(&p, decoder, unit_scale),
            Err(_) => Transform2D::identity(),
        },
        None => Transform2D::identity(),
    };
    let composed = compose_transforms(transform, &placement_transform);

    const CAP_TO_BOX_RATIO: f32 = 0.7;
    const FALLBACK_CAP_HEIGHT_M: f32 = 0.18;
    let height_model_units = if item.ifc_type == IfcType::IfcTextLiteralWithExtent {
        item.get_ref(3)
            .and_then(|extent_ref| decoder.decode_by_id(extent_ref).ok())
            .and_then(|extent| extent.get(1).and_then(|a| a.as_float()))
            .map(|h| (h as f32) * CAP_TO_BOX_RATIO)
            .unwrap_or(FALLBACK_CAP_HEIGHT_M / unit_scale.max(1e-6))
    } else {
        FALLBACK_CAP_HEIGHT_M / unit_scale.max(1e-6)
    };

    let alignment = if item.ifc_type == IfcType::IfcTextLiteralWithExtent {
        item.get(4)
            .and_then(|a| a.as_string())
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };

    let (wx, wy) = composed.transform_point(0.0, 0.0);
    let color = resolve_color_via_styles(item.id, styled_items, decoder)
        .unwrap_or([0.05, 0.05, 0.05, 1.0]);

    out.texts.push(SymbolicText {
        express_id,
        ifc_type: ifc_type.to_string(),
        x: wx - rtc_x,
        y: -wy + rtc_z,
        dir_x: composed.cos_theta,
        dir_y: -composed.sin_theta, // mirror to match Y-flipped coord system
        height: height_model_units * unit_scale,
        content,
        alignment,
        world_y: composed.tz,
        color,
        target_px: 0.0,
        representation: rep_identifier.to_string(),
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Fill area extraction (IfcAnnotationFillArea).
// ────────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn extract_annotation_fill_area(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    styled_items: &HashMap<u32, Vec<u32>>,
    out: &mut SymbolicData,
) {
    let Some(outer_ref) = item.get_ref(0) else { return };
    let mut points = extract_curve_ring(outer_ref, decoder, unit_scale, transform, rtc_x, rtc_z);
    if points.len() < 6 {
        return;
    }

    let mut holes_offsets: Vec<u32> = Vec::new();
    if let Some(inners_attr) = item.get(1) {
        if let Ok(inner_list) = decoder.resolve_ref_list(inners_attr) {
            for inner in inner_list {
                let hole = extract_curve_ring(inner.id, decoder, unit_scale, transform, rtc_x, rtc_z);
                if hole.len() >= 6 {
                    let vertex_index = (points.len() / 2) as u32;
                    holes_offsets.push(vertex_index);
                    points.extend(hole);
                }
            }
        }
    }

    let fill_color = resolve_color_via_styles(item.id, styled_items, decoder)
        .unwrap_or([0.0, 0.0, 0.0, 1.0]);
    let world_y = sample_curve_world_y(outer_ref, decoder, unit_scale) + transform.tz;

    out.fills.push(SymbolicFillArea {
        express_id,
        ifc_type: ifc_type.to_string(),
        points,
        holes_offsets,
        fill_color,
        has_hatching: false,
        hatch_spacing: 0.0,
        hatch_angle: 0.0,
        hatch_angle_secondary: f32::NAN,
        hatch_line_width: 0.0,
        world_y,
        representation: rep_identifier.to_string(),
    });
}

/// Extract one ring of `(x, y)` points from any supported boundary curve.
/// Returns an empty vec on unsupported types or parse failure.
fn extract_curve_ring(
    curve_id: u32,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
) -> Vec<f32> {
    let Ok(curve) = decoder.decode_by_id(curve_id) else {
        return Vec::new();
    };
    match curve.ifc_type {
        IfcType::IfcPolyline => {
            let Some(points_attr) = curve.get(0) else { return Vec::new() };
            let Ok(point_entities) = decoder.resolve_ref_list(points_attr) else {
                return Vec::new();
            };
            let mut out = Vec::with_capacity(point_entities.len() * 2);
            for pe in point_entities {
                if pe.ifc_type != IfcType::IfcCartesianPoint {
                    continue;
                }
                let Some(coords) = pe.get(0).and_then(|a| a.as_list()) else { continue };
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let (wx, wy) = transform.transform_point(x, y);
                out.push(wx - rtc_x);
                out.push(-wy + rtc_z);
            }
            out
        }
        IfcType::IfcIndexedPolyCurve => {
            let Some(points_ref) = curve.get_ref(0) else { return Vec::new() };
            let Ok(points_entity) = decoder.decode_by_id(points_ref) else { return Vec::new() };
            let Some(coord_list_attr) = points_entity.get(0) else { return Vec::new() };
            let Some(coord_list) = coord_list_attr.as_list() else { return Vec::new() };
            let mut out = Vec::with_capacity(coord_list.len() * 2);
            for tuple in coord_list {
                let Some(coords) = tuple.as_list() else { continue };
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let (wx, wy) = transform.transform_point(x, y);
                out.push(wx - rtc_x);
                out.push(-wy + rtc_z);
            }
            out
        }
        IfcType::IfcEllipse => {
            let semi_a = curve.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            let semi_b = curve.get(2).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            if semi_a <= 0.0 || semi_b <= 0.0 || !semi_a.is_finite() || !semi_b.is_finite() {
                return Vec::new();
            }
            let (cx_local, cy_local, _) = circle_center(&curve, decoder, unit_scale);
            const SEGMENTS: usize = 64;
            let mut out = Vec::with_capacity(SEGMENTS * 2);
            for i in 0..SEGMENTS {
                let theta = (i as f32) * std::f32::consts::TAU / (SEGMENTS as f32);
                let lx = cx_local + semi_a * theta.cos();
                let ly = cy_local + semi_b * theta.sin();
                let (wx, wy) = transform.transform_point(lx, ly);
                out.push(wx - rtc_x);
                out.push(-wy + rtc_z);
            }
            out
        }
        IfcType::IfcCircle => {
            let radius = curve.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            if radius <= 0.0 || !radius.is_finite() {
                return Vec::new();
            }
            let (cx_local, cy_local, _) = circle_center(&curve, decoder, unit_scale);
            let seg_count = if radius < 0.05 { 32 } else { 64 };
            let mut out = Vec::with_capacity(seg_count * 2);
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
}

/// Peek at the boundary curve's first 3D point Z so a fill / line can carry
/// its elevation forward. Returns 0.0 for 2D-only curves.
fn sample_curve_world_y(curve_id: u32, decoder: &mut EntityDecoder, unit_scale: f32) -> f32 {
    let Ok(curve) = decoder.decode_by_id(curve_id) else { return 0.0 };
    match curve.ifc_type {
        IfcType::IfcPolyline => {
            let Some(points_attr) = curve.get(0) else { return 0.0 };
            let Ok(point_entities) = decoder.resolve_ref_list(points_attr) else { return 0.0 };
            for pe in point_entities {
                if pe.ifc_type != IfcType::IfcCartesianPoint {
                    continue;
                }
                if let Some(coords) = pe.get(0).and_then(|a| a.as_list()) {
                    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                    return z;
                }
            }
            0.0
        }
        IfcType::IfcCircle | IfcType::IfcEllipse => {
            let (_, _, z) = circle_center(&curve, decoder, unit_scale);
            z
        }
        IfcType::IfcIndexedPolyCurve => {
            let Some(points_ref) = curve.get_ref(0) else { return 0.0 };
            let Ok(points_entity) = decoder.decode_by_id(points_ref) else { return 0.0 };
            let Some(coord_list_attr) = points_entity.get(0) else { return 0.0 };
            let Some(coord_list) = coord_list_attr.as_list() else { return 0.0 };
            if let Some(first) = coord_list.first().and_then(|v| v.as_list()) {
                return first.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            }
            0.0
        }
        _ => 0.0,
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Grid extraction (axis lines + bubble/tag pairs).
// ────────────────────────────────────────────────────────────────────────────

const BUBBLE_OFFSET_M: f32 = 1.2;
const BUBBLE_CAP_M: f32 = 2.0;
const BUBBLE_TARGET_PX: f32 = 32.0;
const TAG_CAP_M: f32 = 0.7;
const TAG_TARGET_PX: f32 = 14.0;

#[allow(clippy::too_many_arguments)]
fn extract_grid(
    grid: &DecodedEntity,
    grid_id: u32,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    out: &mut SymbolicData,
) {
    for axis_attr_idx in [7usize, 8, 9] {
        let Some(axes_attr) = grid.get(axis_attr_idx) else { continue };
        let Ok(axes) = decoder.resolve_ref_list(axes_attr) else { continue };
        for axis in axes {
            if axis.ifc_type != IfcType::IfcGridAxis {
                continue;
            }
            let axis_id = axis.id;
            let tag = axis.get(0).and_then(|a| a.as_string()).unwrap_or("").to_string();

            let Some(curve_ref) = axis.get_ref(1) else { continue };
            let Ok(curve) = decoder.decode_by_id(curve_ref) else { continue };
            let Some((p0, p1)) = sample_grid_axis_endpoints(&curve, decoder, unit_scale, transform)
            else {
                continue;
            };

            let a = (p0.0 - rtc_x, -p0.1 + rtc_z);
            let b = (p1.0 - rtc_x, -p1.1 + rtc_z);
            let world_y = transform.tz;

            // Compact server-friendly entry — keeps the existing endpoint-pair shape.
            out.grid_axes.push(SymbolicGridAxis {
                express_id: axis_id,
                grid_express_id: grid_id,
                tag: tag.clone(),
                endpoints: [a.0, a.1, b.0, b.1],
                world_y,
            });

            // Axis line (browser pipeline: SymbolicPolyline + bubble texts).
            out.polylines.push(SymbolicPolyline {
                express_id: axis_id,
                ifc_type: "IfcGridAxis".to_string(),
                points: vec![a.0, a.1, b.0, b.1],
                closed: false,
                world_y,
                representation: "Axis".to_string(),
            });

            // Unit direction along the axis for bubble offset.
            let dx = b.0 - a.0;
            let dy = b.1 - a.1;
            let len = (dx * dx + dy * dy).sqrt();
            if len < 1e-4 {
                continue;
            }
            let nx = dx / len;
            let ny = dy / len;

            let cx0 = a.0 - nx * BUBBLE_OFFSET_M;
            let cy0 = a.1 - ny * BUBBLE_OFFSET_M;
            emit_bubble(axis_id, cx0, cy0, world_y, &tag, out);

            let cx1 = b.0 + nx * BUBBLE_OFFSET_M;
            let cy1 = b.1 + ny * BUBBLE_OFFSET_M;
            emit_bubble(axis_id, cx1, cy1, world_y, &tag, out);
        }
    }
}

/// Emit a bubble (transparent interior + black outline ○ + tag text) as
/// two stacked text instances. The shader's per-instance `target_px` keeps
/// them at the right relative size at every zoom level.
fn emit_bubble(axis_id: u32, cx: f32, cy: f32, world_y: f32, tag: &str, out: &mut SymbolicData) {
    out.texts.push(SymbolicText {
        express_id: axis_id,
        ifc_type: "IfcGridAxis".to_string(),
        x: cx,
        y: cy,
        dir_x: 1.0,
        dir_y: 0.0,
        height: BUBBLE_CAP_M,
        content: "\u{25EF}".to_string(),
        alignment: "center".to_string(),
        world_y,
        color: [0.0, 0.0, 0.0, 1.0],
        target_px: BUBBLE_TARGET_PX,
        representation: "Axis".to_string(),
    });
    out.texts.push(SymbolicText {
        express_id: axis_id,
        ifc_type: "IfcGridAxis".to_string(),
        x: cx,
        y: cy,
        dir_x: 1.0,
        dir_y: 0.0,
        height: TAG_CAP_M,
        content: tag.to_string(),
        alignment: "center".to_string(),
        world_y,
        color: [0.0, 0.0, 0.0, 1.0],
        target_px: TAG_TARGET_PX,
        representation: "Axis".to_string(),
    });
}

/// Sample the two endpoints of an `IfcGridAxis` curve. In practice always
/// an `IfcPolyline` of two `IfcCartesianPoint`s, but we accept the general
/// polyline shape — first + last points of the list.
fn sample_grid_axis_endpoints(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
    transform: &Transform2D,
) -> Option<((f32, f32), (f32, f32))> {
    if curve.ifc_type != IfcType::IfcPolyline {
        return None;
    }
    let pts_attr = curve.get(0)?;
    let point_entities = decoder.resolve_ref_list(pts_attr).ok()?;
    if point_entities.len() < 2 {
        return None;
    }
    let extract = |pe: &DecodedEntity| -> Option<(f32, f32)> {
        if pe.ifc_type != IfcType::IfcCartesianPoint {
            return None;
        }
        let coords = pe.get(0)?.as_list()?;
        let x = coords.first()?.as_float()? as f32 * unit_scale;
        let y = coords.get(1)?.as_float()? as f32 * unit_scale;
        Some(transform.transform_point(x, y))
    };
    let first = extract(&point_entities[0])?;
    let last = extract(&point_entities[point_entities.len() - 1])?;
    Some((first, last))
}

// ────────────────────────────────────────────────────────────────────────────
// IfcStyledItem reverse index + colour resolution.
// ────────────────────────────────────────────────────────────────────────────

fn build_styled_item_index(content: &str, decoder: &mut EntityDecoder) -> HashMap<u32, Vec<u32>> {
    let collect_refs = |attr: &AttributeValue| -> Vec<u32> {
        if let Some(list) = attr.as_list() {
            list.iter().filter_map(|v| v.as_entity_ref()).collect()
        } else if let Some(single) = attr.as_entity_ref() {
            vec![single]
        } else {
            Vec::new()
        }
    };

    // Pass 1: presentation-style-assignment wrapper map.
    let mut wrappers: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCPRESENTATIONSTYLEASSIGNMENT" {
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else { continue };
        let Some(styles_attr) = entity.get(0) else { continue };
        let inner_refs = collect_refs(styles_attr);
        if !inner_refs.is_empty() {
            wrappers.insert(id, inner_refs);
        }
    }

    // Pass 2: item → style index, unwrapping wrappers transparently.
    let mut out: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCSTYLEDITEM" {
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else { continue };
        let Some(item_ref) = entity.get_ref(0) else { continue };
        let Some(styles_attr) = entity.get(1) else { continue };
        let mut final_refs: Vec<u32> = Vec::new();
        for raw_ref in collect_refs(styles_attr) {
            if let Some(inner) = wrappers.get(&raw_ref) {
                final_refs.extend(inner.iter().copied());
            } else {
                final_refs.push(raw_ref);
            }
        }
        if !final_refs.is_empty() {
            out.entry(item_ref).or_default().extend(final_refs);
        }
    }
    out
}

fn resolve_color_via_styles(
    item_id: u32,
    styled_items: &HashMap<u32, Vec<u32>>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let style_refs = styled_items.get(&item_id)?;
    for style_ref in style_refs {
        if let Some(color) = extract_color_from_style_ref(*style_ref, decoder) {
            return Some(color);
        }
    }
    None
}

fn extract_color_from_style_ref(style_ref: u32, decoder: &mut EntityDecoder) -> Option<[f32; 4]> {
    let style = decoder.decode_by_id(style_ref).ok()?;
    match style.ifc_type {
        IfcType::IfcFillAreaStyle => extract_color_from_fill_area_style(&style, decoder),
        IfcType::IfcTextStyle => extract_color_from_text_style(&style, decoder),
        _ => None,
    }
}

fn extract_color_from_text_style(
    style: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let appearance = decoder.decode_by_id(style.get_ref(1)?).ok()?;
    if appearance.ifc_type != IfcType::IfcTextStyleForDefinedFont {
        return None;
    }
    let colour = decoder.decode_by_id(appearance.get_ref(0)?).ok()?;
    if colour.ifc_type != IfcType::IfcColourRgb {
        return None;
    }
    let r = colour.get(1)?.as_float()? as f32;
    let g = colour.get(2)?.as_float()? as f32;
    let b = colour.get(3)?.as_float()? as f32;
    Some([r, g, b, 1.0])
}

fn extract_color_from_fill_area_style(
    style: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let fill_styles_attr = style.get(1)?;
    let fill_style_refs: Vec<u32> = if let Some(list) = fill_styles_attr.as_list() {
        list.iter().filter_map(|v| v.as_entity_ref()).collect()
    } else if let Some(single) = fill_styles_attr.as_entity_ref() {
        vec![single]
    } else {
        return None;
    };
    for fs_ref in fill_style_refs {
        let Ok(fs) = decoder.decode_by_id(fs_ref) else { continue };
        if fs.ifc_type == IfcType::IfcColourRgb {
            let r = fs.get(1)?.as_float()? as f32;
            let g = fs.get(2)?.as_float()? as f32;
            let b = fs.get(3)?.as_float()? as f32;
            return Some([r, g, b, 1.0]);
        }
    }
    None
}
