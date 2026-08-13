// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use serde::{Deserialize, Serialize};

// ────────────────────────────────────────────────────────────────────────────
// NaN sentinel <-> JSON `null`.
//
// Several scalars below use `f32::NAN` as a SENTINEL meaning "never resolved"
// — `world_y` when the placement chain yields no elevation, and
// `hatch_angle_secondary` when a fill carries no cross-hatch. The whole point
// of that sentinel is that "unresolved" must not read as `0.0`, which is a
// perfectly real elevation / angle.
//
// JSON has no NaN. `serde_json` already WRITES a non-finite `f32` as `null`,
// but the derived `Deserialize` could not READ it back: `invalid type: null,
// expected f32`. So every JSON hop destroyed the sentinel — most sharply in
// `apps/server/src/routes/parse/cache_keys.rs`, where the symbolic cache is
// re-read with `from_slice(..).unwrap_or_else(|_| SymbolicData::default())`,
// meaning ONE unresolved scalar made the entire cached blob unreadable and
// every replayed request served no symbolic data at all.
//
// `nan_as_null` fixes the READ side only. Its serialize half emits exactly
// what `serde_json` already emitted (`null` for NaN, the plain number
// otherwise), so no finite value — `0.0` included — changes shape on the
// wire. `null` and `0` stay distinct, and an OMITTED key stays a hard
// deserialization error rather than a third spelling of "unresolved".
// ────────────────────────────────────────────────────────────────────────────

/// `serialize_with`/`deserialize_with` pair mapping the `f32::NAN`
/// "unresolved" sentinel to and from JSON `null`.
///
/// Read back, any `null` becomes `f32::NAN`. `serde_json` also writes `±inf`
/// as `null`, so an infinity would return as NaN — no producer in this crate
/// emits one, and NaN is the correct reading of "not a usable elevation"
/// either way. Consumers must test `is_nan()`, not `!is_finite()`.
pub(crate) mod nan_as_null {
    use serde::{Deserialize, Deserializer, Serializer};

    pub(crate) fn serialize<S>(value: &f32, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if value.is_nan() {
            serializer.serialize_none()
        } else {
            serializer.serialize_f32(*value)
        }
    }

    pub(crate) fn deserialize<'de, D>(deserializer: D) -> Result<f32, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Option::<f32>::deserialize(deserializer)?.unwrap_or(f32::NAN))
    }
}

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
    /// polyline's own 3D `IfcCartesianPoint` Z component. `f32::NAN` when the
    /// elevation could not be resolved — distinct from a genuine `0.0`, and
    /// spelled `null` on the JSON wire (see [`nan_as_null`]).
    #[serde(with = "nan_as_null")]
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
    #[serde(with = "nan_as_null")]
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
    /// UTF-8 text content, ALREADY DECODED. It is read through
    /// `AttributeValue::from_token`, which un-doubles `''` and runs
    /// `decode_ifc_string` (`\X2\…\X0\`, `\X\NN`, `\S\X`, `\\`) at the parse
    /// boundary (#2394) — so consumers must NOT decode it again. A second
    /// decode is not idempotent: it collapses `\\` twice, turning an authored
    /// `\\server\share` into `\server\share`.
    pub content: String,
    /// IFC `BoxAlignment` (`top-left`, `center`, `bottom-right`, …). Empty
    /// string when absent.
    pub alignment: String,
    /// World-Y elevation (see [`SymbolicPolyline::world_y`]).
    #[serde(with = "nan_as_null")]
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
    /// Secondary cross-hatch angle. NaN if absent — `null` on the JSON wire
    /// (see [`nan_as_null`]), which is NOT the same as a genuine `0.0` angle.
    #[serde(with = "nan_as_null")]
    pub hatch_angle_secondary: f32,
    pub hatch_line_width: f32,
    /// World-Y elevation (see [`SymbolicPolyline::world_y`]).
    #[serde(with = "nan_as_null")]
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
    /// World-Y elevation (see [`SymbolicPolyline::world_y`]).
    #[serde(with = "nan_as_null")]
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
