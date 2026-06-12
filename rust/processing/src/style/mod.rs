// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical IFC styling — the single source of truth for mesh colors,
//! shared between the HTTP server, the native pipeline, and the browser-side
//! WASM bindings (issue #913).
//!
//! This mirrors the [`crate::symbolic`] split: presentation logic that used
//! to be copied into every consumer (`wasm-bindings`, `processing`,
//! `apps/server`, the now-discontinued desktop app) lives here exactly once.
//! See issue #913 for the design and rationale.
//!
//! Phase 0 (this commit) introduces only the two pieces with no decoder or
//! geometry dependency — the canonical [`Rgba`] color type and the single
//! [`default_color_for_type`] table — and wires nothing into the pipeline
//! yet. The decoder-driven resolver (`StyleIndex`, `IfcStyledItem` /
//! `IfcIndexedColourMap` / material-chain resolution) arrives in Phase 2.
//!
//! ## Canonical contracts
//!
//! - **`f32` is canonical; `u8` is transport-only.** Colors are [`Rgba`]
//!   ([`f32; 4`], straight-alpha, `0.0..=1.0`) end-to-end. The browser's
//!   8-bit SharedArrayBuffer transport is expressed *only* through
//!   [`Rgba::to_rgba8`] / [`Rgba::from_rgba8`]; the backend stays exact.
//!   (Decision §8.3 of the plan.)
//! - **One default table.** [`default_color_for_type`] is the only
//!   IFC-type → color map in Rust. A CI guard (Phase 1) fails the build if a
//!   second one appears.

use ifc_lite_core::IfcType;

mod indexed_colour;
mod material;
mod surface;
// Public styling resolvers — the single shared implementation that both the
// native pipeline and the browser `wasm-bindings` call (issue #913, Phase 2e).
// `split_mesh_by_indexed_colour` is also public so the browser `processGeometryBatch`
// path can restore the per-triangle palette split it lost in the #874 mesh-pipeline
// unification (issue #858) — keeping one shared splitter rather than a wasm copy.
pub use indexed_colour::{
    resolve_indexed_colour_map_full, split_mesh_by_indexed_colour, FullIndexedColourMap,
};
pub use material::{
    build_element_material_colors, build_material_style_index, flatten_material_color_index,
    pick_material_style_for_submesh, pick_opaque_first, resolve_material_ids,
    resolve_submesh_color,
};
pub use surface::extract_surface_style_colors;

/// Alpha at or above which a color is treated as opaque.
///
/// Used by submesh material selection (Phase 2) to prefer glass (transparent)
/// vs frame (opaque) styles. Matches the browser's `TRANSPARENCY_ALPHA_THRESHOLD`.
pub const TRANSPARENCY_ALPHA_THRESHOLD: f32 = 0.95;

/// Resolved appearance of one geometry item (the value side of the
/// styled-item index keyed by geometry express id).
///
/// Lives here — not in `processor.rs` — because it is shared by the native
/// pipeline, the canonical per-element producer ([`crate::element`]), and the
/// browser `wasm-bindings` batch path, which lifts its flat `(id, rgba8)`
/// wire arrays into this richer form via [`GeometryStyleInfo::from_color`].
#[derive(Debug, Clone)]
pub struct GeometryStyleInfo {
    /// Apparent colour for rendering: IfcSurfaceStyleRendering.DiffuseColour
    /// when authored, otherwise the SurfaceColour. Matches what most IFC
    /// viewers display.
    pub color: [f32; 4],
    /// SurfaceColour, populated only when the file authored a distinct
    /// DiffuseColour. Read by the WASM bridge's parallel extractor so the
    /// GLB exporter can offer "Shading" as a colour source; the
    /// processing-crate `MeshData` doesn't propagate it (server pipeline
    /// has no GLB consumer yet).
    pub shading_color: Option<[f32; 4]>,
    pub material_name: Option<String>,
}

impl GeometryStyleInfo {
    /// Lift a bare RGBA colour (e.g. from the browser prepass's flat
    /// `styleIds`/`styleColors` wire arrays) into the rich form. No shading
    /// colour, no material name — exactly the fidelity the wire carries.
    pub fn from_color(color: [f32; 4]) -> Self {
        Self {
            color,
            shading_color: None,
            material_name: None,
        }
    }
}

/// Canonical straight-alpha RGBA color, components in `0.0..=1.0`.
///
/// Serializes transparently as a bare `[f32; 4]` JSON array, so it is a
/// drop-in replacement for the `[f32; 4]` colors used across the pipeline
/// today (e.g. `MeshData.color`).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Rgba(pub [f32; 4]);

impl Rgba {
    /// Construct from components.
    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Rgba([r, g, b, a])
    }

    /// Construct from a raw `[f32; 4]`.
    pub const fn from_array(c: [f32; 4]) -> Self {
        Rgba(c)
    }

    /// The underlying `[f32; 4]`.
    pub const fn to_array(self) -> [f32; 4] {
        self.0
    }

    /// The alpha component.
    pub const fn alpha(self) -> f32 {
        self.0[3]
    }

    /// `true` when alpha is below [`TRANSPARENCY_ALPHA_THRESHOLD`].
    pub fn is_transparent(self) -> bool {
        self.0[3] < TRANSPARENCY_ALPHA_THRESHOLD
    }

    /// Quantize to 8-bit RGBA for the browser SAB transport.
    ///
    /// Components are clamped to `0.0..=1.0` then rounded to nearest 1/255.
    /// This is the *only* sanctioned quantization point (plan §8.3); the
    /// backend never calls it.
    pub fn to_rgba8(self) -> [u8; 4] {
        let q = |c: f32| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
        [q(self.0[0]), q(self.0[1]), q(self.0[2]), q(self.0[3])]
    }

    /// Reconstruct from 8-bit RGBA (the inverse of [`Rgba::to_rgba8`],
    /// modulo the 1/255 quantization step).
    pub fn from_rgba8(c: [u8; 4]) -> Self {
        Rgba([
            c[0] as f32 / 255.0,
            c[1] as f32 / 255.0,
            c[2] as f32 / 255.0,
            c[3] as f32 / 255.0,
        ])
    }
}

impl From<[f32; 4]> for Rgba {
    fn from(c: [f32; 4]) -> Self {
        Rgba(c)
    }
}

impl From<Rgba> for [f32; 4] {
    fn from(c: Rgba) -> Self {
        c.0
    }
}

/// The canonical default color for an IFC type.
///
/// This is the **union** of the historical `wasm-bindings` and `processing`
/// tables (plan §8.1): every type keeps the value from whichever table
/// defined it, and `IfcFurnishingElement` resolves to the browser's lighter
/// wood (the value users see today). Types not listed fall through to neutral
/// gray.
pub fn default_color_for_type(ifc_type: IfcType) -> Rgba {
    match ifc_type {
        // Walls — light gray
        IfcType::IfcWall | IfcType::IfcWallStandardCase => Rgba::new(0.85, 0.85, 0.85, 1.0),

        // Slabs — darker gray
        IfcType::IfcSlab => Rgba::new(0.7, 0.7, 0.7, 1.0),

        // Roofs — brown-ish
        IfcType::IfcRoof => Rgba::new(0.6, 0.5, 0.4, 1.0),

        // Columns / beams / members — steel gray
        IfcType::IfcColumn | IfcType::IfcBeam | IfcType::IfcMember => Rgba::new(0.6, 0.65, 0.7, 1.0),

        // Windows — light blue, transparent
        IfcType::IfcWindow => Rgba::new(0.6, 0.8, 1.0, 0.4),

        // Doors — wood brown
        IfcType::IfcDoor => Rgba::new(0.6, 0.45, 0.3, 1.0),

        // Stairs (incl. stair flights — from the processing table)
        IfcType::IfcStair | IfcType::IfcStairFlight => Rgba::new(0.75, 0.75, 0.75, 1.0),

        // Railings
        IfcType::IfcRailing => Rgba::new(0.4, 0.4, 0.45, 1.0),

        // Plates / coverings
        IfcType::IfcPlate | IfcType::IfcCovering => Rgba::new(0.8, 0.8, 0.8, 1.0),

        // Curtain walls — glass blue (from the wasm table)
        IfcType::IfcCurtainWall => Rgba::new(0.5, 0.7, 0.9, 0.5),

        // Furniture — light wood (from the wasm table; §8.1)
        IfcType::IfcFurnishingElement => Rgba::new(0.7, 0.55, 0.4, 1.0),

        // Spaces — cyan, transparent
        IfcType::IfcSpace => Rgba::new(0.2, 0.85, 1.0, 0.3),

        // Spatial zones (modelled GFA volumes) — violet, transparent. A
        // distinct hue from IfcSpace's cyan so net (room) vs gross (zone)
        // areas read apart when both are shown (#1075).
        IfcType::IfcSpatialZone => Rgba::new(0.72, 0.35, 0.95, 0.28),

        // Opening elements — red-orange, transparent
        IfcType::IfcOpeningElement => Rgba::new(1.0, 0.42, 0.29, 0.4),

        // Site — green
        IfcType::IfcSite => Rgba::new(0.4, 0.8, 0.3, 1.0),

        // Building element proxy — generic gray (from the processing table)
        IfcType::IfcBuildingElementProxy => Rgba::new(0.6, 0.6, 0.6, 1.0),

        // Default — neutral gray
        _ => Rgba::new(0.8, 0.8, 0.8, 1.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_array_round_trip() {
        let c = Rgba::new(0.1, 0.2, 0.3, 0.4);
        assert_eq!(c.to_array(), [0.1, 0.2, 0.3, 0.4]);
        assert_eq!(Rgba::from_array([0.1, 0.2, 0.3, 0.4]), c);
        let back: [f32; 4] = c.into();
        assert_eq!(back, [0.1, 0.2, 0.3, 0.4]);
        assert_eq!(Rgba::from([0.5, 0.6, 0.7, 0.8]).alpha(), 0.8);
    }

    #[test]
    fn quantization_clamps_and_rounds() {
        assert_eq!(Rgba::new(0.0, 1.0, 0.5, 1.0).to_rgba8(), [0, 255, 128, 255]);
        // out-of-range components clamp, not wrap
        assert_eq!(Rgba::new(-0.5, 1.5, 0.0, 2.0).to_rgba8(), [0, 255, 0, 255]);
    }

    #[test]
    fn quantization_within_one_step() {
        // Every 8-bit round trip stays within the documented 1/255 tolerance.
        for raw in [0.0_f32, 0.123, 0.4, 0.42, 0.5, 0.555, 0.95, 1.0] {
            let back = Rgba::from_rgba8(Rgba::new(raw, raw, raw, raw).to_rgba8()).to_array();
            assert!((back[0] - raw).abs() <= 1.0 / 255.0, "drift too large for {raw}");
        }
    }

    #[test]
    fn transparency_threshold() {
        assert!(Rgba::new(0.6, 0.8, 1.0, 0.4).is_transparent());
        assert!(!Rgba::new(0.85, 0.85, 0.85, 1.0).is_transparent());
        // exactly the threshold counts as opaque
        assert!(!Rgba::new(0.0, 0.0, 0.0, TRANSPARENCY_ALPHA_THRESHOLD).is_transparent());
    }

    #[test]
    fn defaults_cover_known_types() {
        assert_eq!(
            default_color_for_type(IfcType::IfcWall).to_array(),
            [0.85, 0.85, 0.85, 1.0]
        );
        // IfcWindow is transparent by default
        assert!(default_color_for_type(IfcType::IfcWindow).is_transparent());
        // unmapped type → neutral gray fallback
        assert_eq!(
            default_color_for_type(IfcType::IfcProject).to_array(),
            [0.8, 0.8, 0.8, 1.0]
        );
    }

    #[test]
    fn union_resolves_the_four_contested_types() {
        // The four types that diverged between the historical tables (§2.2).
        assert_eq!(
            default_color_for_type(IfcType::IfcCurtainWall).to_array(),
            [0.5, 0.7, 0.9, 0.5],
            "curtain wall = wasm glass blue"
        );
        assert_eq!(
            default_color_for_type(IfcType::IfcStairFlight).to_array(),
            [0.75, 0.75, 0.75, 1.0],
            "stair flight = processing gray (grouped with IfcStair)"
        );
        assert_eq!(
            default_color_for_type(IfcType::IfcBuildingElementProxy).to_array(),
            [0.6, 0.6, 0.6, 1.0],
            "proxy = processing gray"
        );
        assert_eq!(
            default_color_for_type(IfcType::IfcFurnishingElement).to_array(),
            [0.7, 0.55, 0.4, 1.0],
            "furnishing = wasm light wood, not processing's darker brown"
        );
        // IfcStair and IfcStairFlight must agree.
        assert_eq!(
            default_color_for_type(IfcType::IfcStair),
            default_color_for_type(IfcType::IfcStairFlight)
        );
    }
}
