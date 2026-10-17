// SPDX-License-Identifier: MPL-2.0
//! Colour-space conversion shared by the exporters whose colour inputs are
//! linear (glTF, USD). COLLADA/KMZ deliberately stay outside it (see
//! `collada.rs`), plus the material-dedup keys and default colour all the
//! writers share.

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

/// Colour a mesh gets when the caller's colour buffer has no entry for it:
/// mid-grey (0.8) and opaque.
pub(crate) const DEFAULT_RGBA: [f32; 4] = [0.8, 0.8, 0.8, 1.0];

/// Mesh `i`'s RGBA out of a flat `[r, g, b, a, ...]` buffer, each missing
/// channel taking its [`DEFAULT_RGBA`] value.
pub(crate) fn rgba_at(colors: &[f32], i: usize) -> [f32; 4] {
    std::array::from_fn(|k| colors.get(i * 4 + k).copied().unwrap_or(DEFAULT_RGBA[k]))
}

/// The one material dedup key (glTF, COLLADA, USD): RGBA rounded to 2 decimals
/// (the TS exporter's resolution), a non-finite channel -> 0, then clamped to
/// `0..=100`. Out-of-gamut colours therefore share the nearest in-gamut
/// bucket, and USD's derived prim name stays a legal identifier (#7777).
pub(crate) fn material_key(c: [f32; 4]) -> (i32, i32, i32, i32) {
    let r = |v: f32| {
        let v = if v.is_finite() { v } else { 0.0 };
        ((v * 100.0).round() as i32).clamp(0, 100)
    };
    (r(c[0]), r(c[1]), r(c[2]), r(c[3]))
}

#[cfg(test)]
mod key_tests {
    use super::material_key;

    #[test]
    fn key_is_clamped_with_non_finite_to_zero() {
        assert_eq!(material_key([-0.1, 2.0, 0.5, f32::NAN]), (0, 100, 50, 0));
        assert_eq!(material_key([f32::INFINITY, f32::NEG_INFINITY, 0.504, 0.996]), (0, 0, 50, 100));
        // Out-of-gamut shares the in-gamut bucket.
        assert_eq!(material_key([1.5, 1.0, 1.0, 1.0]), material_key([1.0; 4]));
    }
}
