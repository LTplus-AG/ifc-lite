// SPDX-License-Identifier: MPL-2.0
//! Colour-space conversion shared by the exporters whose colour inputs are
//! linear (glTF, USD). COLLADA/KMZ deliberately stay outside it (see
//! `collada.rs`).

/// IEC 61966-2-1 sRGB electro-optical transfer function (decode): maps a
/// gamma-encoded channel in `[0, 1]` to linear light. `IfcColourRgb` components
/// are authored the way every BIM tool's colour picker works — a perceptual
/// (sRGB) swatch, the same convention IfcOpenShell/BlenderBIM follow when
/// building a renderer's albedo input — while glTF's `baseColorFactor` and
/// `emissiveFactor` are defined in LINEAR space (glTF 2.0 spec, "Reference
/// Material"). Copying the sRGB value straight into `baseColorFactor` skips
/// this decode and renders every colour too bright/washed out in any
/// spec-compliant consumer (Blender, three.js, Cesium — the whole point of
/// exporting glTF for tools outside this repo). Metallic/roughness factors are
/// NOT colour and must never go through this — only RGB channels that end up
/// as a `*Factor` colour do.
///
/// The same holds for USD: `UsdPreviewSurface.inputs:diffuseColor` and
/// `primvars:displayColor` are linear too, so `usd` decodes through here and
/// the two exporters cannot disagree about what an IFC colour means.
fn srgb_to_linear(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// An IFC RGBA colour with RGB decoded through [`srgb_to_linear`]. Alpha is
/// opacity, not a gamma-encoded light quantity, and passes through.
pub(crate) fn srgba_to_linear(c: [f32; 4]) -> [f32; 4] {
    [srgb_to_linear(c[0]), srgb_to_linear(c[1]), srgb_to_linear(c[2]), c[3]]
}
