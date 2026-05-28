// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Server-side 2D symbol extraction (issue #843).
//!
//! Provides a minimal parity layer with the browser-side
//! `parse_symbolic_representations` API in `rust/wasm-bindings/src/api/symbolic.rs`,
//! producing pure-Rust (no `wasm_bindgen`) data the HTTP server can
//! serialize alongside its 3D mesh response.
//!
//! Today this covers the two most-requested symbol families:
//!
//! - `IfcGrid` axes — extracted from the `UAxes` / `VAxes` / `WAxes`
//!   attributes, emitting endpoint pairs per axis.
//! - `IfcAnnotation` polylines — extracted from the entity's
//!   `Annotation` / `FootPrint` / `Plan` shape representations,
//!   sampling `IfcPolyline` items.
//!
//! Richer 2D primitives (trimmed-curve arcs, fill areas, text literals)
//! still live wasm-side and need a deeper refactor of `symbolic.rs` into
//! this crate before they can land server-side. The scaffolding here
//! intentionally mirrors the field names from the wasm collection so a
//! follow-up that moves the full extraction will be a drop-in.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};
use serde::{Deserialize, Serialize};

/// A single 2D polyline in the floor-plan plane.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolicPolyline {
    /// Express ID of the IFC entity that authored the curve.
    pub express_id: u32,
    /// Owning element's IFC type (e.g. `"IfcAnnotation"`, `"IfcGridAxis"`).
    pub ifc_type: String,
    /// Flat `[x0, y0, x1, y1, …]` 2D point list in metres.
    pub points: Vec<f32>,
    /// True if the curve is a closed loop (last point == first).
    pub closed: bool,
    /// Optional plan-view Y elevation (storey height, in metres).
    pub world_y: f32,
    /// Representation identifier the curve came from
    /// (`Annotation`, `FootPrint`, `Plan`, or `Axis`).
    pub representation: String,
}

/// A single IfcGridAxis tag + axis curve.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolicGridAxis {
    /// Express ID of the IfcGridAxis.
    pub express_id: u32,
    /// Owning IfcGrid express ID.
    pub grid_express_id: u32,
    /// The grid axis tag (`"A"`, `"1"`, etc.).
    pub tag: String,
    /// Endpoint pair `[x0, y0, x1, y1]` in metres (plan view).
    pub endpoints: [f32; 4],
    /// Plan-view Y elevation (storey height, in metres).
    pub world_y: f32,
}

/// Server-friendly summary of the IFC's 2D symbol data.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SymbolicData {
    /// All `IfcGridAxis` curves discovered in the file.
    pub grid_axes: Vec<SymbolicGridAxis>,
    /// All polylines from `IfcAnnotation` (and other elements that carry
    /// a 2D `Annotation` / `FootPrint` / `Plan` representation).
    pub polylines: Vec<SymbolicPolyline>,
}

impl SymbolicData {
    /// Returns true if no symbolic primitives were extracted — the server
    /// can omit the field from its response instead of emitting an empty
    /// object.
    pub fn is_empty(&self) -> bool {
        self.grid_axes.is_empty() && self.polylines.is_empty()
    }
}

/// Scan an IFC file for `IfcGrid` and `IfcAnnotation` entities and return
/// their 2D primitives. Pure-Rust (no `wasm_bindgen`), so it works inside
/// the HTTP server.
pub fn extract_symbolic_data(content: &str) -> SymbolicData {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    // Reuse the geometry router for both unit-scale and placement
    // resolution. Without applying placements, an IfcGrid at storey N
    // emits its axis points with `world_y = 0` and any rotated grid /
    // off-origin storey leaks raw local coordinates through to the
    // client — see PR #852 review (chatgpt-codex P1).
    let router = ifc_lite_geometry::GeometryRouter::with_units(content, &mut decoder);
    let unit_scale = router.unit_scale() as f32;

    let mut data = SymbolicData::default();
    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        let is_grid = type_name == "IFCGRID";
        let is_annotation = type_name == "IFCANNOTATION";
        if !is_grid && !is_annotation {
            continue;
        }

        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };

        // Resolve the entity's world-space placement. Returns identity
        // when the entity has no IfcLocalPlacement (degenerate but
        // legal — those still work fine here, the points just stay in
        // the file's authored coordinate frame).
        let placement = router
            .resolve_scaled_placement(&entity, &mut decoder)
            .ok();

        if is_grid {
            extract_grid_axes(&entity, &mut decoder, unit_scale, placement.as_ref(), &mut data);
        } else {
            extract_annotation_polylines(
                &entity,
                &mut decoder,
                unit_scale,
                placement.as_ref(),
                &mut data,
            );
        }
    }

    data
}

/// Apply a 4×4 placement matrix (column-major, `[m00, m10, m20, m30,
/// m01, …]`) to a metres-scaled `(x, y)` point. Returns the world
/// position in metres, retaining only x/y (z is folded into `world_y`).
#[inline]
fn apply_placement_xy(placement: &[f64; 16], x_m: f32, y_m: f32) -> (f32, f32, f32) {
    // nalgebra Matrix4 stores column-major: index = col*4 + row.
    let x = x_m as f64;
    let y = y_m as f64;
    // z is 0 because the point came from a 2D IfcCartesianPoint
    let wx = placement[0] * x + placement[4] * y + placement[12];
    let wy = placement[1] * x + placement[5] * y + placement[13];
    let wz = placement[2] * x + placement[6] * y + placement[14];
    (wx as f32, wy as f32, wz as f32)
}

/// Extract endpoint pairs from each axis in `IfcGrid.UAxes` / `VAxes` /
/// `WAxes`. The axis curves are typically `IfcPolyline`s with two points,
/// so we just pull the first and last point.
fn extract_grid_axes(
    grid: &ifc_lite_core::DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
    placement: Option<&[f64; 16]>,
    out: &mut SymbolicData,
) {
    for axis_attr_idx in [7usize, 8, 9] {
        let Some(axes_attr) = grid.get(axis_attr_idx) else {
            continue;
        };
        let Ok(axes) = decoder.resolve_ref_list(axes_attr) else {
            continue;
        };
        for axis in axes {
            if axis.ifc_type != IfcType::IfcGridAxis {
                continue;
            }
            let tag = axis
                .get(0)
                .and_then(|a| a.as_string())
                .unwrap_or("")
                .to_string();
            let Some(curve_ref) = axis.get_ref(1) else {
                continue;
            };
            let Ok(curve) = decoder.decode_by_id(curve_ref) else {
                continue;
            };

            if let Some([p0, p1]) = polyline_endpoints(&curve, decoder, unit_scale) {
                // Apply the grid's IfcLocalPlacement to lift each
                // 2D axis endpoint into world space. Without this,
                // grids at a storey offset emit `world_y = 0` and
                // rotated grids leak raw local XY. Z component
                // populates `world_y` so the renderer can lift each
                // grid axis to its host storey.
                let (p0w, p1w, world_y) = match placement {
                    Some(m) => {
                        let p0w = apply_placement_xy(m, p0.0, p0.1);
                        let p1w = apply_placement_xy(m, p1.0, p1.1);
                        let world_y = 0.5 * (p0w.2 + p1w.2);
                        ((p0w.0, p0w.1), (p1w.0, p1w.1), world_y)
                    }
                    None => (p0, p1, 0.0_f32),
                };
                out.grid_axes.push(SymbolicGridAxis {
                    express_id: axis.id,
                    grid_express_id: grid.id,
                    tag,
                    endpoints: [p0w.0, p0w.1, p1w.0, p1w.1],
                    world_y,
                });
            }
        }
    }
}

/// Pull `IfcPolyline` items from an `IfcAnnotation`'s `Annotation` /
/// `FootPrint` / `Plan` shape representations.
fn extract_annotation_polylines(
    annotation: &ifc_lite_core::DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
    placement: Option<&[f64; 16]>,
    out: &mut SymbolicData,
) {
    let Some(rep_attr) = annotation.get(6) else {
        return;
    };
    if rep_attr.is_null() {
        return;
    }
    let Ok(Some(rep)) = decoder.resolve_ref(rep_attr) else {
        return;
    };
    if rep.ifc_type != IfcType::IfcProductDefinitionShape {
        return;
    }
    let Some(reps_attr) = rep.get(2) else { return };
    let Ok(reps) = decoder.resolve_ref_list(reps_attr) else {
        return;
    };
    for shape_rep in reps {
        if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
            continue;
        }
        let rep_ident = shape_rep
            .get(1)
            .and_then(|a| a.as_string())
            .unwrap_or("")
            .to_string();
        if !matches!(
            rep_ident.as_str(),
            "Annotation" | "FootPrint" | "Plan" | "Axis"
        ) {
            continue;
        }
        let Some(items_attr) = shape_rep.get(3) else {
            continue;
        };
        let Ok(items) = decoder.resolve_ref_list(items_attr) else {
            continue;
        };
        for item in items {
            if item.ifc_type != IfcType::IfcPolyline {
                continue;
            }
            if let Some(points) = polyline_points(&item, decoder, unit_scale) {
                let closed = points.len() >= 4
                    && (points.first(), points.get(points.len() - 2)) ==
                        (points.first(), points.get(points.len() - 2))
                    && points.first() == points.get(points.len() - 2)
                    && points.get(1) == points.get(points.len() - 1);
                // Same placement-resolution rationale as
                // `extract_grid_axes`: rotated or storey-offset
                // annotations need their authored 2D coords lifted
                // into world space, and the z component populates
                // `world_y` so the client renders each polyline at
                // its host storey's elevation.
                let (placed_points, world_y) = match placement {
                    Some(m) => {
                        let mut placed = Vec::with_capacity(points.len());
                        let mut z_sum = 0.0_f32;
                        let mut z_count = 0_u32;
                        for chunk in points.chunks_exact(2) {
                            let w = apply_placement_xy(m, chunk[0], chunk[1]);
                            placed.push(w.0);
                            placed.push(w.1);
                            z_sum += w.2;
                            z_count += 1;
                        }
                        let world_y = if z_count > 0 { z_sum / z_count as f32 } else { 0.0 };
                        (placed, world_y)
                    }
                    None => (points, 0.0_f32),
                };
                out.polylines.push(SymbolicPolyline {
                    express_id: item.id,
                    ifc_type: "IfcAnnotation".to_string(),
                    points: placed_points,
                    closed,
                    world_y,
                    representation: rep_ident.clone(),
                });
            }
        }
    }
}

/// First and last point of an `IfcPolyline`, in metres.
fn polyline_endpoints(
    polyline: &ifc_lite_core::DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
) -> Option<[(f32, f32); 2]> {
    if polyline.ifc_type != IfcType::IfcPolyline {
        return None;
    }
    let pts_attr = polyline.get(0)?;
    let pt_refs = pts_attr.as_list()?;
    if pt_refs.len() < 2 {
        return None;
    }
    let first = decode_xy(decoder, pt_refs.first()?, unit_scale)?;
    let last = decode_xy(decoder, pt_refs.last()?, unit_scale)?;
    Some([first, last])
}

/// Flat `[x0, y0, x1, y1, …]` point list for an `IfcPolyline`, in metres.
fn polyline_points(
    polyline: &ifc_lite_core::DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
) -> Option<Vec<f32>> {
    if polyline.ifc_type != IfcType::IfcPolyline {
        return None;
    }
    let pts_attr = polyline.get(0)?;
    let pt_refs = pts_attr.as_list()?;
    let mut out = Vec::with_capacity(pt_refs.len() * 2);
    for r in pt_refs {
        let (x, y) = decode_xy(decoder, r, unit_scale)?;
        out.push(x);
        out.push(y);
    }
    if out.len() < 4 {
        return None;
    }
    Some(out)
}

/// Decode an `IfcCartesianPoint` reference into a metre-scaled 2D pair,
/// dropping any Z component (this is a 2D extractor).
fn decode_xy(
    decoder: &mut EntityDecoder,
    point_ref: &ifc_lite_core::AttributeValue,
    unit_scale: f32,
) -> Option<(f32, f32)> {
    let id = point_ref.as_entity_ref()?;
    let pt = decoder.decode_by_id(id).ok()?;
    let coords = pt.get(0).and_then(|v| v.as_list())?;
    let x = coords.first().and_then(|v| v.as_float())? as f32 * unit_scale;
    let y = coords.get(1).and_then(|v| v.as_float())? as f32 * unit_scale;
    Some((x, y))
}
