// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use serde::{Deserialize, Serialize};

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
