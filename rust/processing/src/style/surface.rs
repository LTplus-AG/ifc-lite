/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Canonical `IfcSurfaceStyle` → colour extraction, shared by the processing
//! (server/CLI) and wasm (viewer) geometry pipelines so they cannot drift on
//! surface-style rendering semantics — the coordinate/colour analogue of the
//! single default-colour table (#913).

use ifc_lite_core::{EntityDecoder, IfcType};

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
    let styles_attr = style.get(2)?;
    let list = styles_attr.as_list()?;
    for item in list {
        if let Some(element_id) = item.as_entity_ref() {
            if let Some(pair) = rendering_colours(element_id, decoder) {
                return Some(pair);
            }
        }
    }
    None
}
