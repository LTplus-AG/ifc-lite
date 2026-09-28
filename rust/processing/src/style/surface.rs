/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Canonical `IfcSurfaceStyle` → colour extraction, shared by the processing
//! (server/CLI) and wasm (viewer) geometry pipelines so they cannot drift on
//! surface-style rendering semantics — the coordinate/colour analogue of the
//! single default-colour table (#913).

use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};

/// Read an `IfcColourRgb` as linear `[r, g, b, 1.0]` (alpha is filled by the
/// caller from the rendering's transparency). Missing components default to 0.8
/// (mid-grey), matching the historical behaviour on both pipelines.
fn read_colour_rgb(color_id: u32, decoder: &mut EntityDecoder) -> Option<[f32; 4]> {
    let color = decoder.decode_by_id(color_id).ok()?;
    if color.ifc_type != IfcType::IfcColourRgb {
        return None;
    }
    // IfcColourRgb: Name(0), Red(1), Green(2), Blue(3) — same in IFC2x3 and IFC4.
    let r = color.get_float(1).unwrap_or(0.8) as f32;
    let g = color.get_float(2).unwrap_or(0.8) as f32;
    let b = color.get_float(3).unwrap_or(0.8) as f32;
    Some([r, g, b, 1.0])
}

/// Colours of a single `IfcSurfaceStyleRendering` / `IfcSurfaceStyleShading`.
///
/// Returns `(apparent, shading)`:
/// - `apparent` is `SurfaceColour` (attr 0), modulated by `DiffuseColour`
///   (attr 2) **only** when the author supplied it as an
///   `IfcNormalisedRatioMeasure` factor. `SurfaceColour` is the apparent surface
///   colour per the IFC spec and how web-ifc / IfcOpenShell / BlenderBIM read
///   the chain.
/// - `shading` is populated only when a *distinct* `DiffuseColour` `IfcColourRgb`
///   is authored, for downstream consumers that want the diffuse override (the
///   GLB exporter's "Shading" source).
///
/// A `DiffuseColour = IfcColourRgb(0, 0, 0)` therefore does NOT black out the
/// surface — that is the spec's "no diffuse reflection contribution", and the
/// regression #859/#871 fixed (otherwise every `IfcSignal` / `IfcReferent` on
/// the railway fixture rendered opaque black).
fn rendering_colours(
    rendering_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<([f32; 4], Option<[f32; 4]>)> {
    let rendering = decoder.decode_by_id(rendering_id).ok()?;
    match rendering.ifc_type {
        IfcType::IfcSurfaceStyleRendering | IfcType::IfcSurfaceStyleShading => {
            // Attr 0: SurfaceColour, Attr 1: Transparency (0=opaque, 1=transparent),
            // Attr 2: DiffuseColour — SELECT(IfcColourRgb, IfcNormalisedRatioMeasure),
            // only present on IfcSurfaceStyleRendering.
            let color_ref = rendering.get_ref(0)?;
            let [sr, sg, sb, _] = read_colour_rgb(color_ref, decoder)?;

            let transparency = rendering.get_float(1).unwrap_or(0.0);
            let alpha = (1.0 - transparency as f32).clamp(0.0, 1.0);
            let surface_rgba = [sr, sg, sb, alpha];

            let mut apparent = surface_rgba;
            let mut shading: Option<[f32; 4]> = None;

            if rendering.ifc_type == IfcType::IfcSurfaceStyleRendering {
                if let Some(diffuse_id) = rendering.get_ref(2) {
                    if let Some([dr, dg, db, _]) = read_colour_rgb(diffuse_id, decoder) {
                        let diffuse_rgba = [dr, dg, db, alpha];
                        // Surface the diffuse override only when it actually
                        // differs — it is NOT the apparent colour.
                        if diffuse_rgba != surface_rgba {
                            shading = Some(diffuse_rgba);
                        }
                    }
                } else if let Some(factor) = rendering.get_float(2) {
                    let f = (factor as f32).clamp(0.0, 1.0);
                    apparent = [sr * f, sg * f, sb * f, alpha];
                }
            }

            Some((apparent, shading))
        }
        _ => None,
    }
}

/// Extract the apparent surface colour (and an optional distinct shading colour)
/// from an `IfcSurfaceStyle`, walking its `Styles` list (attr 2) and returning
/// the first rendering's `(apparent, shading)` pair.
///
/// This is the **single source of truth** for surface-style colour, consumed by
/// both the server geometry processor and the browser pre-pass, so the two
/// cannot disagree on `SurfaceColour` vs `DiffuseColour` precedence.
pub fn extract_surface_style_colors(
    surface_style_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<([f32; 4], Option<[f32; 4]>)> {
    let style = decoder.decode_by_id(surface_style_id).ok()?;
    if style.ifc_type != IfcType::IfcSurfaceStyle {
        return None;
    }
    // IfcSurfaceStyle: Name(0), Side(1), Styles(2: list of surface-style elements).
    for element_id in style.get_refs(2)? {
        if let Some(pair) = rendering_colours(element_id, decoder) {
            return Some(pair);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Specular finish (#5582): `IfcSurfaceStyleRendering.SpecularColour` /
// `.SpecularHighlight` / `.ReflectanceMethod` → a metallic/roughness pair.
//
// `IfcSurfaceStyleRendering` (SUBTYPE OF `IfcSurfaceStyleShading`) flattens to
// 9 attributes: 0 SurfaceColour, 1 Transparency (both on `IfcSurfaceStyleShading`),
// then 2 DiffuseColour, 3 TransmissionColour, 4 DiffuseTransmissionColour,
// 5 ReflectionColour, 6 SpecularColour, 7 SpecularHighlight, 8 ReflectanceMethod
// (`IFC4_ADD2_TC1.exp`). Verified against `AC20-FZK-Haus.ifc`'s 'Glas'
// (`SpecularColour = IFCNORMALISEDRATIOMEASURE(1.)`) and 'Kiefer, glänzend'
// (`SpecularColour = IFCNORMALISEDRATIOMEASURE(0.75)`), both with a null
// `SpecularHighlight` and `ReflectanceMethod = .NOTDEFINED.` — the common case
// for BIM-authoring exporters, which populate the scalar factor and nothing
// else.
//
// Roughness is passed through AS AUTHORED, clamped only to the valid `[0, 1]`
// range — never floored here. A roughness near 0 is numerically unstable in
// the renderer's Cook-Torrance term (GGX `alpha = roughness^2` approaches 0),
// but the renderer already owns exactly one clamp for that
// (`MIN_SPECULAR_ROUGHNESS = 0.045`, `shaders/specular.wgsl.ts`); flooring
// here too would be a second, independently-tunable copy of the same guard
// (and did briefly disagree with it, review of #5582).
// ---------------------------------------------------------------------------

/// Metallic/roughness evidence read from one `IfcSurfaceStyleRendering`.
/// Either field is `None` when the file carries no evidence for it; the
/// renderer's `packMeshMaterial` then falls back to its own default
/// (`DEFAULT_MATERIAL_METALLIC` / `DEFAULT_MATERIAL_ROUGHNESS`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SpecularMaterial {
    pub metallic: Option<f32>,
    pub roughness: Option<f32>,
}

impl SpecularMaterial {
    fn is_empty(&self) -> bool {
        self.metallic.is_none() && self.roughness.is_none()
    }
}

/// `ReflectanceMethod` values the IFC spec models as a conductor: a metal or
/// mirror surface reflects via a coloured Fresnel term with no diffuse
/// transmission, the physical signature `metallic = 1.0` encodes in the
/// glTF/PBR metallic-roughness model. Every other enumerator (`BLINN`,
/// `FLAT`, `GLASS`, `MATT`, `PHONG`, `PLASTIC`, `STRAUSS`, `NOTDEFINED`) is a
/// dielectric shading model, so it carries no metal evidence either way.
fn reflectance_method_is_metal(method: &str) -> bool {
    matches!(method, "METAL" | "MIRROR")
}

/// A `SpecularColour` authored as an actual `IfcColourRgb` (rather than the
/// far more common `IfcNormalisedRatioMeasure` scalar factor) tints the
/// specular reflection. Only a conductor's Fresnel reflectance is
/// wavelength-dependent — a dielectric's specular reflectance is always
/// achromatic regardless of its base colour, which is exactly the split the
/// glTF metallic-roughness model itself relies on. A saturated tint is
/// therefore treated as authored evidence of a metal even when
/// `ReflectanceMethod` was left `NOTDEFINED` (the common case: most
/// exporters never populate the enum).
fn specular_colour_is_tinted(rgb: [f32; 3]) -> bool {
    const SATURATION_TINT_THRESHOLD: f32 = 0.08;
    let max = rgb[0].max(rgb[1]).max(rgb[2]);
    let min = rgb[0].min(rgb[1]).min(rgb[2]);
    (max - min) > SATURATION_TINT_THRESHOLD
}

/// Convert a Blinn-Phong specular exponent (`IfcSpecularExponent`, an
/// unbounded REAL, typically 1..1000+) to a GGX roughness via the standard
/// Phong-to-GGX approximation `roughness = sqrt(2 / (n + 2))` (Brian Karis,
/// "Physically Based Shading on Mobile", 2014). A tighter highlight (higher
/// exponent) maps to a lower roughness.
fn phong_exponent_to_roughness(exponent: f32) -> f32 {
    (2.0 / (exponent.max(0.0) + 2.0)).sqrt().clamp(0.0, 1.0)
}

/// `SpecularColour` (attr 6), a `SELECT(IfcColourRgb, IfcNormalisedRatioMeasure)`.
enum SpecularColour {
    /// A scalar reflectance factor in `[0, 1]`.
    Factor(f32),
    /// An authored tint (linear, unclamped — only the saturation and
    /// luminance are read, so out-of-range components don't need clamping).
    Colour([f32; 3]),
}

fn read_specular_colour(rendering: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<SpecularColour> {
    if let Some(color_id) = rendering.get_ref(6) {
        let [r, g, b, _] = read_colour_rgb(color_id, decoder)?;
        // A non-finite component (a malformed or overflowed STEP real) is no
        // evidence: it would reach the tint test and the luminance fallback,
        // where `f32::clamp` passes `NaN` through unchanged (#5582 review).
        return [r, g, b]
            .iter()
            .all(|c| c.is_finite())
            .then_some(SpecularColour::Colour([r, g, b]));
    }
    rendering
        .get_float(6)
        .map(|f| f as f32)
        // Same non-finite guard as `read_specular_highlight`: `f32::clamp`
        // returns `NaN` unchanged rather than saturating it, so a malformed
        // factor would otherwise survive as `Factor(NaN)` (#5582 review).
        .filter(|f| f.is_finite())
        .map(|f| SpecularColour::Factor(f.clamp(0.0, 1.0)))
}

/// `SpecularHighlight` (attr 7), a `SELECT(IfcSpecularExponent, IfcSpecularRoughness)`.
/// Both select members are plain `REAL`s, so the STEP encoding carries the
/// choice only as a type tag (`IFCSPECULAREXPONENT(20.)` vs
/// `IFCSPECULARROUGHNESS(0.1)`), which the tokenizer preserves as a
/// `List([String(type_name), Float(value)])` (`AttributeValue::from_token`).
/// Returns `(is_roughness, value)`; an untagged bare real (non-conformant,
/// never seen in practice) is treated as an exponent, since that is the
/// historically dominant Blinn-Phong wording of "specular highlight size".
///
/// A non-finite authored value (`NaN`/`±inf`, from a malformed file) carries
/// no usable evidence, so the whole attribute is treated as unauthored
/// (`None`) rather than feeding a garbage number into the roughness/exponent
/// conversion below — `exponent.max(0.0)` alone does not reliably reject it
/// (review of #5582).
fn read_specular_highlight(rendering: &DecodedEntity) -> Option<(bool, f32)> {
    let attr = rendering.get(7)?;
    let (is_roughness, value) = if let AttributeValue::List(items) = attr {
        let (Some(AttributeValue::String(name)), Some(value_attr)) = (items.first(), items.get(1))
        else {
            return None;
        };
        (name.eq_ignore_ascii_case("IFCSPECULARROUGHNESS"), value_attr.as_float()? as f32)
    } else {
        (false, attr.as_float()? as f32)
    };
    value.is_finite().then_some((is_roughness, value))
}

/// Resolve the metallic/roughness pair for one `IfcSurfaceStyleRendering`.
///
/// - `metallic` is `1.0` when `ReflectanceMethod` names a conductor (`METAL`,
///   `MIRROR`), or when `SpecularColour` is an authored tint rather than a
///   scalar factor; otherwise `None` (defer to the renderer's dielectric
///   default).
/// - `roughness` prefers `SpecularHighlight` when present (an
///   `IfcSpecularRoughness` factor is used directly; an `IfcSpecularExponent`
///   is converted via [`phong_exponent_to_roughness`]); otherwise it falls
///   back to `1 - SpecularColour`, reading `SpecularColour`'s luminance when
///   it is a tint rather than a factor. `None` when neither attribute is
///   authored.
fn rendering_specular_material(
    rendering: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<SpecularMaterial> {
    if rendering.ifc_type != IfcType::IfcSurfaceStyleRendering {
        // IfcSurfaceStyleShading carries none of these attributes.
        return None;
    }

    let reflectance_is_metal = rendering
        .get(8)
        .and_then(AttributeValue::as_enum)
        .map(reflectance_method_is_metal)
        .unwrap_or(false);

    let specular_colour = read_specular_colour(rendering, decoder);
    let tinted_metal = matches!(
        specular_colour,
        Some(SpecularColour::Colour(rgb)) if specular_colour_is_tinted(rgb)
    );
    let metallic = (reflectance_is_metal || tinted_metal).then_some(1.0);

    let highlight_roughness = read_specular_highlight(rendering).map(|(is_roughness, value)| {
        if is_roughness {
            // IfcSpecularRoughness (WR1: 0..=1) as authored — no floor here,
            // see the module doc above.
            value.clamp(0.0, 1.0)
        } else {
            phong_exponent_to_roughness(value)
        }
    });
    let factor_roughness = match specular_colour {
        Some(SpecularColour::Factor(f)) => Some((1.0 - f).clamp(0.0, 1.0)),
        Some(SpecularColour::Colour([r, g, b])) => {
            let luma = (0.2126 * r + 0.7152 * g + 0.0722 * b).clamp(0.0, 1.0);
            Some((1.0 - luma).clamp(0.0, 1.0))
        }
        None => None,
    };

    let material = SpecularMaterial {
        metallic,
        roughness: highlight_roughness.or(factor_roughness),
    };
    (!material.is_empty()).then_some(material)
}

/// Extract the metallic/roughness pair from an `IfcSurfaceStyle`'s first
/// `IfcSurfaceStyleRendering`, walking its `Styles` list (attr 2) exactly as
/// [`extract_surface_style_colors`] does, so the two never disagree about
/// which rendering "wins" for a multi-style `IfcSurfaceStyle`.
///
/// Lives here, in the canonical styling module, rather than as a parallel
/// path (see `AGENTS.md` "Colour and coordinate resolution is canonical
/// Rust"): both the server (`process_geometry`) and the viewer
/// (`process_geometry_batch`) reach this through the shared
/// `GeometryStyleInfo` the prepass builds (`prepass.rs`), so they cannot
/// drift on the mapping.
pub fn extract_surface_style_specular(
    surface_style_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<SpecularMaterial> {
    let style = decoder.decode_by_id(surface_style_id).ok()?;
    if style.ifc_type != IfcType::IfcSurfaceStyle {
        return None;
    }
    for element_id in style.get_refs(2)? {
        let Ok(rendering) = decoder.decode_by_id(element_id) else {
            continue;
        };
        if let Some(material) = rendering_specular_material(&rendering, decoder) {
            return Some(material);
        }
    }
    None
}

#[cfg(test)]
#[path = "surface_tests.rs"]
mod tests;
